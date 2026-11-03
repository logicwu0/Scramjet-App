// Loopback-only mock. No real passwords or school accounts are accepted.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const tickets = new Map();
const callback = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:8080");
if (
	callback.username ||
	callback.password ||
	callback.search ||
	callback.hash ||
	callback.pathname !== "/" ||
	(callback.protocol !== "https:" &&
		!(
			callback.protocol === "http:" &&
			["127.0.0.1", "localhost"].includes(callback.hostname)
		))
)
	throw new Error("Invalid mock APP_ORIGIN");
const callbackOrigin = callback.origin;
const port = Number(process.env.MOCK_CAS_PORT || 9080);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
	throw new Error("Invalid MOCK_CAS_PORT");
const escape = (value) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;");
createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1:9080");
	res.setHeader("Cache-Control", "no-store");
	for (const [ticket, entry] of tickets)
		if (entry.expires < Date.now()) tickets.delete(ticket);
	if (url.pathname === "/cas/login") {
		let service;
		try {
			service = new URL(url.searchParams.get("service"));
		} catch {
			res.writeHead(400).end();
			return;
		}
		if (
			service.origin !== callbackOrigin ||
			service.pathname !== "/auth/callback"
		) {
			res.writeHead(400).end("Invalid service");
			return;
		}
		if (url.searchParams.get("demo") !== "1") {
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(
				`<meta charset="utf-8"><title>本地模拟 CAS</title><h1>本地模拟 CAS（不是学校认证）</h1><p>仅用虚拟账户 student-demo，不输入真实密码。</p><form><input type="hidden" name="service" value="${escape(service.href)}"><input type="hidden" name="demo" value="1"><button>使用模拟学生登录</button></form>`
			);
			return;
		}
		if (tickets.size >= 2000) {
			res.writeHead(503).end();
			return;
		}
		const ticket = "ST-" + randomBytes(24).toString("hex");
		tickets.set(ticket, { service: service.href, expires: Date.now() + 60000 });
		service.searchParams.set("ticket", ticket);
		res.writeHead(302, { Location: service.href }).end();
	} else if (url.pathname === "/cas/serviceValidate" && req.method === "POST") {
		let body = "";
		for await (const chunk of req) {
			body += chunk;
			if (body.length > 8192) {
				res.writeHead(413).end();
				return;
			}
		}
		const params = new URLSearchParams(body),
			ticket = params.get("ticket"),
			entry = tickets.get(ticket);
		tickets.delete(ticket);
		const valid =
			entry &&
			entry.expires > Date.now() &&
			entry.service === params.get("service");
		res.setHeader("Content-Type", "application/xml");
		res.end(
			`<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">${valid ? "<cas:authenticationSuccess><cas:user>student-demo</cas:user></cas:authenticationSuccess>" : '<cas:authenticationFailure code="INVALID_TICKET">Invalid ticket</cas:authenticationFailure>'}</cas:serviceResponse>`
		);
	} else if (url.pathname === "/cas/logout") {
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.end(
			`<meta charset="utf-8"><h1>已退出模拟认证</h1><a href="${escape(callbackOrigin)}/auth/login">重新登录</a>`
		);
	} else res.writeHead(404).end();
}).listen(port, "127.0.0.1", () =>
	console.log(`Mock CAS: http://127.0.0.1:${port}/cas/login (loopback only)`)
);
