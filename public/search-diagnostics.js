// Bounded, local diagnostics for comparing an affected browser with a fresh one.
// Keep cookie values, search terms and complete URLs out of diagnostic payloads.
self.webvpnSearchDiagnostics = function (worker) {
	const pending = new Map();
	let reports = 0;
	function report(data) {
		if (reports++ >= 40) return;
		void fetch("/api/proxy-diagnostics", {method:"POST",credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}).catch(()=>{});
	}
	function page(url) {
		if (!["www.google.com", "www.google.com.hk", "www.recaptcha.net", "recaptcha.google.com", "www.gstatic.com"].includes(url.hostname)) return null;
        if (url.pathname.startsWith("/recaptcha/")) {
            if (url.hostname === "www.gstatic.com") return "captcha-script";
            if (url.pathname.endsWith("/anchor") || url.pathname.endsWith("/bframe")) return "captcha-frame";
            if (url.pathname.endsWith("/reload") || url.pathname.endsWith("/userverify")) return "captcha-verify";
            return "captcha-resource";
        }
		return url.pathname === "/search" ? "search" : url.pathname.startsWith("/sorry/") ? "challenge" : null;
	}
	worker.addEventListener("request", (event) => {
		const kind = page(event.url);
		if (!kind) return;
		const headers = Object.fromEntries(Object.entries(event.requestHeaders).map(([k,v]) => [k.toLowerCase(), String(v)]));
		if (pending.size >= 32) pending.delete(pending.keys().next().value);
		const data = {
			host: event.url.hostname, page: kind,
			destination: headers["sec-fetch-dest"], site: headers["sec-fetch-site"], mode: headers["sec-fetch-mode"],
			hasAuthorization: Boolean(headers.authorization),
			cookieCount: headers.cookie ? headers.cookie.split(";").filter(v => v.trim()).length : 0,
		};
		pending.set(event.url.href, data);
		report({...data,status:0});
	});
	worker.addEventListener("handleResponse", (event) => {
		const data = pending.get(event.url.href);
		pending.delete(event.url.href);
		if (data) report({...data,status:event.status});
	});
};
