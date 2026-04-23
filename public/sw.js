importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

const MAX_CONCURRENT_SCRAMJET = 4;
let scramjetActive = 0;
const scramjetQueue = [];
function acquireScramjetSlot() {
	if (scramjetActive < MAX_CONCURRENT_SCRAMJET) {
		scramjetActive++;
		return Promise.resolve();
	}
	return new Promise((resolve) => scramjetQueue.push(resolve));
}
function releaseScramjetSlot() {
	if (scramjetQueue.length) {
		scramjetQueue.shift()();
	} else {
		scramjetActive--;
	}
}

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
	await scramjet.loadConfig();
	const url = event.request.url;
	const routed = scramjet.route(event);
	console.log(`[SW] ${event.request.method} ${url} routed=${routed}`);
	if (routed) await acquireScramjetSlot();
	const tFetch = Date.now();
	if (routed && scramjetQueue.length) {
		console.log(`[SW] queue depth=${scramjetQueue.length} active=${scramjetActive} url=${url}`);
	}
	let slotReleased = false;
	const release = () => {
		if (routed && !slotReleased) {
			slotReleased = true;
			releaseScramjetSlot();
		}
	};
	try {
		let res;
		try {
			res = routed ? await scramjet.fetch(event) : await fetch(event.request);
		} finally {
			release();
		}
		console.log(`[SW] <- ${res.status} ${url} fetchTime=${Date.now() - tFetch}ms`);
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
		release();
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
