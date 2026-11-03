import { randomBytes } from "node:crypto";
import { SaxesParser } from "saxes";

const NS = "http://www.yale.edu/tp/cas";
const random = () => randomBytes(32).toString("base64url");
const html = (s) =>
	s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			]
	);

export function configFromEnv(env = process.env) {
	const local = env.CAS_LOCAL_TEST === "1";
	const origin = new URL(env.APP_ORIGIN || "http://127.0.0.1:8080");
	const cas = new URL(env.CAS_BASE_URL || "https://cas.ncu.edu.cn:8443/cas/");
	for (const url of [origin, cas]) {
		if (url.username || url.password || url.search || url.hash)
			throw new Error("Invalid authentication URL");
		if (
			url.protocol !== "https:" &&
			!(
				local &&
				url.protocol === "http:" &&
				["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
			)
		) {
			throw new Error(
				"HTTPS required; localhost HTTP requires CAS_LOCAL_TEST=1"
			);
		}
	}
	if (origin.pathname !== "/")
		throw new Error("APP_ORIGIN must be an origin without a path");
	if (!cas.pathname.endsWith("/")) cas.pathname += "/";
	// Test deployments expose the mock login over HTTPS, but validate tickets
	// over a loopback-only channel behind the reverse proxy's access protection.
	let mockBackend;
	if (env.CAS_MOCK_BACKEND_URL) {
		mockBackend = new URL(env.CAS_MOCK_BACKEND_URL);
		if (
			mockBackend.protocol !== "http:" ||
			!["127.0.0.1", "[::1]"].includes(mockBackend.hostname) ||
			mockBackend.username ||
			mockBackend.password ||
			mockBackend.search ||
			mockBackend.hash ||
			mockBackend.pathname !== "/cas/"
		) {
			throw new Error(
				"CAS_MOCK_BACKEND_URL must be an HTTP loopback /cas/ URL"
			);
		}
	}
	const seconds = Number(env.CAS_SESSION_SECONDS || 3600);
	if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400)
		throw new Error("CAS_SESSION_SECONDS must be 60..86400");
	return {
		origin: origin.origin,
		cas: cas.href,
		mockBackend: mockBackend?.href,
		local,
		ttl: seconds * 1000,
		onlineCheck: env.CAS_ONLINE_CHECK === "1",
		maxSessions: 2000,
		pendingTtl: 300000,
		timeout: 8000,
	};
}

// Namespace-aware, bounded XML parser. DTDs/custom entities are never accepted.
export function parseValidation(xml) {
	if (Buffer.byteLength(xml) > 65536) throw new Error("CAS response too large");
	const parser = new SaxesParser({ xmlns: true });
	const stack = [];
	let root = false,
		success = 0,
		failure = 0,
		users = 0,
		username = "";
	parser.on("doctype", () => {
		throw new Error("DTD forbidden");
	});
	parser.on("error", () => {
		throw new Error("Invalid CAS XML");
	});
	parser.on("opentag", (tag) => {
		stack.push(tag);
		if (stack.length > 20) throw new Error("CAS XML too deep");
		if (stack.length === 1)
			root = tag.uri === NS && tag.local === "serviceResponse";
		if (stack.length === 2 && tag.uri === NS) {
			if (tag.local === "authenticationSuccess") success++;
			if (tag.local === "authenticationFailure") failure++;
		}
		if (
			stack.length === 3 &&
			stack[1].uri === NS &&
			stack[1].local === "authenticationSuccess" &&
			tag.uri === NS &&
			tag.local === "user"
		)
			users++;
		if (stack.length > 3 && stack[2].local === "user")
			throw new Error("Invalid user element");
	});
	const text = (value) => {
		if (
			stack.length === 3 &&
			stack[1].uri === NS &&
			stack[1].local === "authenticationSuccess" &&
			stack[2].uri === NS &&
			stack[2].local === "user"
		)
			username += value;
	};
	parser.on("text", text);
	parser.on("cdata", text);
	parser.on("closetag", () => stack.pop());
	parser.write(xml).close();
	username = username.trim();
	if (
		!root ||
		success !== 1 ||
		failure ||
		users !== 1 ||
		!username ||
		username.length > 256 ||
		/[\x00-\x1f\x7f]/.test(username)
	)
		throw new Error("CAS rejected login");
	return username;
}

export function createCasAuth(
	config,
	{ fetchImpl = fetch, now = Date.now } = {}
) {
	const sessions = new Map(),
		pending = new Map();
	const cookieName = config.local ? "webvpn_session" : "__Host-webvpn_session";
	const pendingName = config.local ? "webvpn_login" : "__Host-webvpn_login";
	const cookie = (name, value, age) =>
		`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.local ? "" : "; Secure"}`;
	const readCookie = (req, name) => {
		const values = (req.headers.cookie || "")
			.split(";")
			.map((s) => s.trim())
			.filter((s) => s.startsWith(name + "="));
		return values.length === 1 ? values[0].slice(name.length + 1) : "";
	};
	const revoke = (id) => {
		const session = sessions.get(id);
		if (!session) return;
		sessions.delete(id);
		clearTimeout(session.timer);
		for (const socket of session.sockets) socket.destroy();
	};
	const sweep = () => {
		for (const [id, entry] of pending)
			if (entry.expires <= now()) pending.delete(id);
		for (const [id, entry] of sessions) if (entry.expires <= now()) revoke(id);
	};
	let checking = false;
	async function checkOnline() {
		if (!config.onlineCheck || checking) return;
		checking = true;
		try {
			// Sequential checks bound outbound concurrency. Any failed check revokes fail-closed.
			for (const [id, session] of sessions) {
				try {
					const response = await fetchImpl(
						new URL("login/userOnlineDetect", config.mockBackend || config.cas),
						{
							method: "POST",
							redirect: "error",
							signal: AbortSignal.timeout(config.timeout),
							headers: { "Content-Type": "application/x-www-form-urlencoded" },
							body: new URLSearchParams({
								service: session.service,
								ticket: session.ticket,
								username: session.username,
							}),
						}
					);
					const data = await limitedBody(response);
					const state = JSON.parse(data);
					if (state.code !== 0 || state.data?.isAlive !== true) revoke(id);
				} catch {
					revoke(id);
				}
			}
		} finally {
			checking = false;
		}
	}
	const timer = setInterval(() => {
		sweep();
		void checkOnline();
	}, 30000);
	timer.unref();
	const sessionFor = (req) => {
		const id = readCookie(req, cookieName),
			session = sessions.get(id);
		if (session && session.expires > now()) return session;
		revoke(id);
		return null;
	};
	const clear = (req, reply) => {
		revoke(readCookie(req, cookieName));
		pending.delete(readCookie(req, pendingName));
		reply.header("Set-Cookie", [
			cookie(cookieName, "", 0),
			cookie(pendingName, "", 0),
		]);
	};
	async function limitedBody(response) {
		if (!response.ok || !response.body) throw new Error("CAS unavailable");
		const reader = response.body.getReader();
		let length = 0;
		const chunks = [];
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > 65536) throw new Error("CAS response too large");
				chunks.push(Buffer.from(value));
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	async function validate(ticket, service) {
		const response = await fetchImpl(
			new URL("serviceValidate", config.mockBackend || config.cas),
			{
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(config.timeout),
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/xml, text/xml",
				},
				body: new URLSearchParams({ ticket, service }),
			}
		);
		return parseValidation(await limitedBody(response));
	}
	function register(app) {
		app.addHook("onRequest", async (req, reply) => {
			reply
				.header("Cache-Control", "no-store")
				.header("Referrer-Policy", "no-referrer");
			const path = req.url.split("?")[0];
			if (path.startsWith("/auth/")) return;
			if (!sessionFor(req.raw)) {
				if (req.method === "GET" && ["/", "/index.html"].includes(path))
					return reply.redirect("/auth/login");
				return reply
					.code(401)
					.send({ error: "login_required", login: "/auth/login" });
			}
		});
		app.get("/auth/login", async (req, reply) => {
			sweep();
			if (sessionFor(req.raw)) return reply.redirect("/");
			if (pending.size >= config.maxSessions)
				return reply.code(503).send("登录请求繁忙，请稍后重试");
			pending.delete(readCookie(req.raw, pendingName));
			const id = random(),
				nonce = random();
			const service = new URL("/auth/callback", config.origin);
			service.searchParams.set("nonce", nonce);
			pending.set(id, {
				nonce,
				service: service.href,
				expires: now() + config.pendingTtl,
			});
			reply.header(
				"Set-Cookie",
				cookie(pendingName, id, config.pendingTtl / 1000)
			);
			const login = new URL("login", config.cas);
			login.searchParams.set("service", service.href);
			return reply.redirect(login.href);
		});
		app.get("/auth/callback", async (req, reply) => {
			const params = new URL(req.url, config.origin).searchParams;
			const id = readCookie(req.raw, pendingName),
				entry = pending.get(id);
			pending.delete(id); // Consume before asynchronous validation, including failures.
			reply.header("Set-Cookie", cookie(pendingName, "", 0));
			const ticket = params.get("ticket");
			if (
				!entry ||
				entry.expires <= now() ||
				params.getAll("nonce").length !== 1 ||
				params.get("nonce") !== entry.nonce ||
				params.getAll("ticket").length !== 1 ||
				!/^ST-[A-Za-z0-9._~-]{1,2048}$/.test(ticket || "")
			) {
				return reply
					.code(400)
					.send("登录请求无效或已过期，请重新访问 /auth/login");
			}
			try {
				const username = await validate(ticket, entry.service);
				sweep();
				if (sessions.size >= config.maxSessions)
					return reply.code(503).send("当前会话数已达上限");
				revoke(readCookie(req.raw, cookieName));
				const sid = random();
				const session = {
					username,
					csrf: random(),
					expires: now() + config.ttl,
					sockets: new Set(),
					...(config.onlineCheck ? { ticket, service: entry.service } : {}),
				};
				session.timer = setTimeout(() => revoke(sid), config.ttl);
				session.timer.unref();
				sessions.set(sid, session);
				reply.header("Set-Cookie", [
					cookie(pendingName, "", 0),
					cookie(cookieName, sid, config.ttl / 1000),
				]);
				return reply.redirect("/");
			} catch {
				// Never log the callback URL, ticket, XML response, or cookies.
				return reply
					.code(502)
					.send("统一认证校验未成功，请重新登录或联系管理员");
			}
		});
		app.get("/auth/session", async (req, reply) => {
			const session = sessionFor(req.raw);
			if (!session) return reply.code(401).send({ authenticated: false });
			return {
				authenticated: true,
				username: session.username,
				expiresAt: session.expires,
			};
		});
		// Supwisdom front-channel JSONP logout: this is intentionally a logout-only endpoint.
		// Cross-site cookie restrictions may prevent identifying a session; enable online detection as backup.
		app.get("/auth/slo", async (req, reply) => {
			const params = new URL(req.url, config.origin).searchParams;
			const callback = params.get("callback");
			if (
				params.getAll("callback").length !== 1 ||
				!/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(callback || "")
			)
				return reply.code(400).send("Invalid callback");
			clear(req.raw, reply);
			reply.header("X-Content-Type-Options", "nosniff");
			return reply
				.type("application/javascript")
				.send(
					`${callback}({"code":0,"message":null,"data":{"success":"注销成功"}});`
				);
		});
		app.get("/auth/account", async (req, reply) => {
			const session = sessionFor(req.raw);
			if (!session) return reply.redirect("/auth/login");
			// Preserve Origin on the same-origin logout form (notably WebKit).
			reply.header("Referrer-Policy", "same-origin");
			reply.header(
				"Content-Security-Policy",
				`default-src 'none'; form-action 'self' ${new URL(config.cas).origin}; frame-ancestors 'none'`
			);
			return reply
				.type("text/html; charset=utf-8")
				.send(
					`<!doctype html><meta charset="utf-8"><title>南昌大学 WebVPN 账户</title><h1>已登录</h1><p>${html(session.username)}</p><a href="/">返回 WebVPN</a><form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${session.csrf}"><button>退出登录</button></form>`
				);
		});
		app.addContentTypeParser(
			"application/x-www-form-urlencoded",
			{ parseAs: "string", bodyLimit: 4096 },
			(req, body, done) => done(null, body)
		);
		app.post("/auth/logout", async (req, reply) => {
			const session = sessionFor(req.raw);
			const params = new URLSearchParams(
				typeof req.body === "string" ? req.body : ""
			);
			if (
				!session ||
				req.headers.origin !== config.origin ||
				params.get("csrf") !== session.csrf
			)
				return reply.code(403).send("退出请求无效");
			clear(req.raw, reply);
			const logout = new URL("logout", config.cas);
			logout.searchParams.set(
				"service",
				new URL("/auth/login", config.origin).href
			);
			return reply.redirect(logout.href, 303);
		});
		app.addHook("onClose", async () => close());
	}
	function authorizeUpgrade(req, socket) {
		const session = sessionFor(req);
		let denial;
		if (req.url !== "/wisp/") denial = [404, "Not Found", "invalid_path"];
		else if (req.headers.origin !== config.origin)
			denial = [403, "Forbidden", "origin_mismatch"];
		else if (!session) denial = [401, "Unauthorized", "session_required"];
		if (denial) {
			const [status, message, reason] = denial;
			console.warn(`[auth] Wisp upgrade rejected: ${reason}`);
			socket.end(
				`HTTP/1.1 ${status} ${message}\r\nX-WebVPN-Auth-Error: ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
			);
			return false;
		}
		session.sockets.add(socket);
		socket.once("close", () => session.sockets.delete(socket));
		return true;
	}
	function close() {
		clearInterval(timer);
		for (const id of sessions.keys()) revoke(id);
		pending.clear();
	}
	return { register, authorizeUpgrade, close, checkOnline };
}
