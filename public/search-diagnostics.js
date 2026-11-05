// Bounded, local diagnostics for comparing an affected browser with a fresh one.
// Keep cookie values, search terms and complete URLs out of diagnostic payloads.
self.webvpnSearchDiagnostics = function (worker) {
	const pending = new Map();
	let reports = 0;
	function page(url) {
		if (!["www.google.com", "www.google.com.hk"].includes(url.hostname)) return null;
		return url.pathname === "/search" ? "search" : url.pathname.startsWith("/sorry/") ? "challenge" : null;
	}
	worker.addEventListener("request", (event) => {
		const kind = page(event.url);
		if (!kind) return;
		const headers = Object.fromEntries(Object.entries(event.requestHeaders).map(([k,v]) => [k.toLowerCase(), String(v)]));
		if (pending.size >= 32) pending.delete(pending.keys().next().value);
		pending.set(event.url.href, {
			host: event.url.hostname, page: kind,
			destination: headers["sec-fetch-dest"], site: headers["sec-fetch-site"], mode: headers["sec-fetch-mode"],
			hasAuthorization: Boolean(headers.authorization),
			cookieCount: headers.cookie ? headers.cookie.split(";").filter(v => v.trim()).length : 0,
		});
	});
	worker.addEventListener("handleResponse", (event) => {
		const data = pending.get(event.url.href);
		pending.delete(event.url.href);
		if (!data || reports >= 10) return;
		reports++;
		void fetch("/api/proxy-diagnostics", {
			method: "POST", credentials: "same-origin", cache: "no-store",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...data, status: event.status }),
		}).catch(() => {});
	});
};
