importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
	await scramjet.loadConfig();
	const url = event.request.url;
	const routed = scramjet.route(event);
	console.log(`[SW] ${event.request.method} ${url} routed=${routed}`);
	try {
		const res = routed ? await scramjet.fetch(event) : await fetch(event.request);
		console.log(`[SW] <- ${res.status} ${url}`);
		return res;
	} catch (err) {
		console.error(`[SW] FAIL ${url}:`, err && err.message ? err.message : err);
		throw err;
	}
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
