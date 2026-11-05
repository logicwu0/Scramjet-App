// Temporary, local-only request-shape diagnostics. Never accept URLs, queries,
// cookies, credentials, accounts or arbitrary client strings into the journal.
export function registerProxyDiagnostics(app, origin, { write = console.warn, now = Date.now } = {}) {
	let windowStart = 0, count = 0;
	app.post("/api/proxy-diagnostics", { bodyLimit: 2048 }, async (req, reply) => {
		if (req.headers.origin !== origin) return reply.code(403).send();
		const data = req.body;
		if (!data || !["www.google.com", "www.google.com.hk", "www.recaptcha.net", "recaptcha.google.com", "www.gstatic.com"].includes(data.host) ||
			!["search", "challenge", "captcha-script", "captcha-frame", "captcha-verify", "captcha-resource"].includes(data.page) ||
			!Number.isInteger(data.status) || (data.status !== 0 && data.status < 100) || data.status > 599)
			return reply.code(400).send();
		if (now() - windowStart >= 60000) { windowStart = now(); count = 0; }
		if (++count > 60) return reply.code(429).send();
		const choice = (value, values) => values.includes(value) ? value : "unknown";
		write("[WebVPN search diagnostic] " + JSON.stringify({
			version: "captcha-v2", host: data.host, page: data.page, status: data.status,
			destination: choice(data.destination, ["document", "iframe", "empty"]),
			site: choice(data.site, ["none", "same-origin", "same-site", "cross-site"]),
			mode: choice(data.mode, ["navigate", "cors", "no-cors", "same-origin"]),
			hasAuthorization: data.hasAuthorization === true,
			cookieCount: Number.isInteger(data.cookieCount) ? Math.max(0, Math.min(1000, data.cookieCount)) : 0,
		}));
		return reply.code(204).send();
	});
}
