// Diagnostic schema: captcha-v2 (no queries or credential values).
importScripts("/scram/scramjet.all.js");
importScripts("/proxy-headers.js");
importScripts("/search-diagnostics.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
self.webvpnSearchDiagnostics(scramjet);

scramjet.addEventListener("request", (event) => {
	const repaired = self.webvpnNormalizeProxyHeaders(event.requestHeaders);
	if (repaired.length) {
		console.warn("[WebVPN] encoded non-ByteString cookie characters", { target: event.url.origin });
	}
	const invalid = Object.entries(event.requestHeaders)
		.filter(([name, value]) => /[^\x00-\xff]/u.test(name + String(value)))
		.map(([name]) => name);
	if (invalid.length) {
		// Only header names and target origin: never log cookie or credential values.
		console.error("[WebVPN] invalid proxy header characters", { target: event.url.origin, headers: invalid });
	}
});

scramjet.addEventListener("handleResponse", (event) => {
	if (event.status === 401 || event.status === 403) {
		console.warn("[WebVPN] upstream access response", { target: event.url.origin, status: event.status });
	}
});

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

function isFragileSubresource(request, routed) {
	if (!routed) return false;
	const destination = (request.destination || "").toLowerCase();
	const secDest = (request.headers.get("sec-fetch-dest") || "").toLowerCase();
	const url = request.url.toLowerCase();
	const destLike = destination === "script" || destination === "style" || secDest === "script" || secDest === "style";
	const urlLike = /(?:\.|%2e)(?:m?js|css)(?:$|[?#])/.test(url) || url.includes("mathjax") || url.includes("chunk") || url.includes("vendor");
	return destLike || urlLike;
}

async function handleRequest(event) {
	const url = event.request.url;
	const lowerUrl = url.toLowerCase();
	const reqUrl = new URL(url);
	// Authentication must bypass proxy processing and never log tickets or nonce URLs.
	if (reqUrl.origin === self.location.origin && (reqUrl.pathname.startsWith("/auth/") || reqUrl.pathname.startsWith("/cas/"))) {
		return fetch(event.request);
	}
	if (event.request.mode === "navigate" && reqUrl.pathname.startsWith("/web/")) {
		const dest = event.request.destination;
		const sfd = event.request.headers.get("Sec-Fetch-Dest");
		console.log(`[SW] /web/ nav inspect: dest=${dest} sfd=${sfd} clientId='${event.clientId}' resultingClientId='${event.resultingClientId}'`);
		// Top-level new tab: destination is "document", existing clientId is empty.
		// iframe internal nav: destination is "iframe" (don't redirect, let scramjet handle).
		if (dest === "document") {
			const tail = reqUrl.pathname.slice("/web/".length) + reqUrl.search;
			console.log(`[SW] top-level /web/ nav -> redirect to /#${tail}`);
			return Response.redirect(`${reqUrl.origin}/#${tail}`, 302);
		}
	}
	const purpose = event.request.headers.get("Sec-Purpose") || event.request.headers.get("Purpose") || "";
	await scramjet.loadConfig();
	const routed = scramjet.route(event);
	const fragile = isFragileSubresource(event.request, routed);
	if (purpose.includes("prefetch")) {
		const isChallengePath = lowerUrl.includes("/cdn-cgi/");
		if (!isChallengePath) {
			console.log(`[SW] DROP prefetch ${url}`);
			return new Response(null, { status: 204 });
		}
		console.log(`[SW] KEEP prefetch challenge ${url}`);
	}
	console.log(`[SW] ${event.request.method} ${url} routed=${routed} fragile=${fragile}`);
	try {
		const res = routed ? await scramjet.fetch(event) : await fetch(event.request);
		console.log(`[SW] <- ${res.status} ${url}`);
		if (routed && lowerUrl.includes("/cdn-cgi/")) {
			console.log(`[SW] challenge passthrough ${url}`);
			return res;
		}
		const contentType = (res.headers.get("content-type") || "").toLowerCase();
		const contentLike = contentType.includes("javascript") || contentType.includes("ecmascript") || contentType.includes("text/css");
		if (fragile || contentLike) {
			console.log(`[SW] fragile/content passthrough ${url} ct=${contentType}`);
			return res;
		}
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
