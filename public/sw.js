importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

function dumpError(prefix, err) {
	if (!err) {
		console.error(`${prefix} <no error object>`);
		return;
	}
	const info = {
		name: err.name,
		message: err.message,
		ctor: err.constructor && err.constructor.name,
		stack: err.stack,
	};
	try {
		info.keys = Object.keys(err);
		info.string = String(err);
	} catch (_) {}
	console.error(`${prefix}`, info);
	if (err.cause) dumpError(`${prefix} [cause]`, err.cause);
}

async function handleRequest(event) {
	const url = event.request.url;
	const purpose = event.request.headers.get("Sec-Purpose") || event.request.headers.get("Purpose") || "";
	if (purpose.includes("prefetch")) {
		console.log(`[SW] DROP prefetch ${url}`);
		return new Response(null, { status: 204 });
	}
	await scramjet.loadConfig();
	const routed = scramjet.route(event);
	console.log(`[SW] ${event.request.method} ${url} routed=${routed}`);
	try {
		const res = routed ? await scramjet.fetch(event) : await fetch(event.request);
		console.log(`[SW] <- ${res.status} ${url}`);
		if (!routed || !res.body) return res;
		const reader = res.body.getReader();
		const t0 = Date.now();
		let bytes = 0, closed = false;
		const stream = new ReadableStream({
			start(controller) {
				const timer = setTimeout(() => {
					if (!closed) console.warn(`[SW] body STILL OPEN after 10s ${url} bytes=${bytes}`);
				}, 10000);
				(async () => {
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							bytes += value.byteLength || value.length || 0;
							controller.enqueue(value);
						}
						controller.close();
						closed = true;
						console.log(`[SW] body CLOSED ${url} bytes=${bytes} time=${Date.now() - t0}ms`);
					} catch (e) {
						console.error(`[SW] body ERR ${url}`, e);
						try { controller.error(e); } catch (_) {}
					} finally {
						clearTimeout(timer);
					}
				})();
			},
			cancel(reason) {
				console.warn(`[SW] body CANCEL ${url} reason=`, reason);
				try { reader.cancel(reason); } catch (_) {}
			}
		});
		return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
	} catch (err) {
		dumpError(`[SW] FAIL ${url}`, err);
		throw err;
	}
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});

self.addEventListener("unhandledrejection", (ev) => {
	dumpError("[SW] unhandledrejection", ev.reason);
});
self.addEventListener("error", (ev) => {
	dumpError("[SW] error", ev.error || ev.message);
});
