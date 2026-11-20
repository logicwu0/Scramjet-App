// Diagnostic schema: captcha-v3 (no queries or credential values).
importScripts("/scram/scramjet.all.js");
importScripts("/proxy-headers.js");
importScripts("/navigation-policy-shared.js");
importScripts("/search-diagnostics.js");

// This update keeps the same pinned proxy engine and storage schema.
// Activate the compatible worker without requiring users to erase site data.
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

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

// Match only the exact, short-lived Google redirect selected in a portal tab.
const resultClicks = new Map();
self.addEventListener('message', event => {
    const data = event.data;
    if (data?.type !== 'search-result-redirect' || !event.source?.url ||
        new URL(event.source.url).origin !== location.origin || new URL(event.source.url).pathname !== '/') return;
    try {
        const url = new URL(data.url), source = new URL(data.source);
        if (url.href.length > 8192 || source.href.length > 8192 || url.origin !== source.origin ||
            source.pathname !== '/search' || !source.searchParams.get('q') || !['/url','/goto'].includes(url.pathname)) return;
        const click = {source:source.href};
        if (resultClicks.size >= 256) resultClicks.delete(resultClicks.keys().next().value);
        resultClicks.set(url.href, click);
        setTimeout(() => { if (resultClicks.get(url.href) === click) resultClicks.delete(url.href); }, 60000);
    } catch { /* Unrecognized relay URL. */ }
});

function proxyTarget(value) {
    try {
        const url = new URL(value, location.origin);
        if (url.origin !== location.origin) return url.href;
        if (url.pathname.startsWith('/web/')) return decodeURIComponent(url.pathname.slice(5) + url.search);
        if (url.pathname === '/' && url.hash) return decodeURIComponent(url.hash.slice(1));
    } catch {}
    return '';
}
function searchClickContext(request, target) {
    const ref = proxyTarget(request.referrer);
    const source = self.webvpnSanitizeNavigationURL(ref);
    if (source?.search_query && target && new URL(target).origin === new URL(source.url).origin &&
        ['/url','/goto'].includes(new URL(target).pathname) && request.method === 'GET')
        return {source:source.url};
    return resultClicks.get(target) || resultClicks.get(ref);
}

function rememberRelay(target, context) {
    if (!context || !target || target.length > 8192) return;
    const url = new URL(target);
    if (url.origin !== new URL(context.source).origin || !['/url','/goto'].includes(url.pathname)) return;
    if (resultClicks.size >= 256) resultClicks.delete(resultClicks.keys().next().value);
    resultClicks.set(target, context);
    setTimeout(() => { if (resultClicks.get(target) === context) resultClicks.delete(target); }, 60000);
}

function reportRedirect(context, value) {
    if (!context || !value || context.reported) return;
    const target = self.webvpnSanitizeNavigationURL(value);
    if (!target || new URL(target.url).origin === new URL(context.source).origin) return;
    context.reported = true;
    return fetch('/api/navigation-log', {method:'POST', credentials:'same-origin', keepalive:true,
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({event_id:crypto.randomUUID(),
            source_url:context.source, target_url:target.url, source_relation:'search_result_click',
            url_redacted:target.redacted, client_timestamp:new Date().toISOString()})}).catch(() => {});
}

async function handleRequest(event) {
	const url = event.request.url;
	const lowerUrl = url.toLowerCase();
	const reqUrl = new URL(url);
	// Authentication must bypass proxy processing and never log tickets or nonce URLs.
	if (reqUrl.origin === self.location.origin && (reqUrl.pathname.startsWith("/auth/") || reqUrl.pathname.startsWith("/cas/"))) {
		return fetch(event.request);
	}
    const navigationTarget = event.request.mode === 'navigate' && reqUrl.pathname.startsWith('/web/')
        ? proxyTarget(url) : '';
    let clickContext;
    if (navigationTarget) {
        try {
            clickContext = searchClickContext(event.request, navigationTarget);
            rememberRelay(navigationTarget, clickContext);
        } catch { /* Malformed proxy URL. */ }
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
        if (routed && navigationTarget) {
            try {
                clickContext ||= resultClicks.get(navigationTarget);
                if (!clickContext && event.clientId) {
                    const client = await self.clients.get(event.clientId);
                    if (client) clickContext = resultClicks.get(proxyTarget(client.url));
                }
                if (clickContext) {
                    let target = navigationTarget;
                    if (res.status >= 300 && res.status < 400 && res.headers.has('location'))
                        target = proxyTarget(res.headers.get('location'));
                    rememberRelay(target, clickContext);
                    const report = reportRedirect(clickContext, target);
                    if (report) event.waitUntil(report);
                }
            } catch { /* Optional logging must never interrupt the response. */ }
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
