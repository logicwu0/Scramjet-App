import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import {
	configFromEnv,
	createCasAuth,
	parseValidation,
} from "../src/auth/cas.js";

const xml = (name = "student01") =>
	`<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess><cas:user>${name}</cas:user></cas:authenticationSuccess></cas:serviceResponse>`;
function config() {
	return configFromEnv({
		CAS_LOCAL_TEST: "1",
		APP_ORIGIN: "http://127.0.0.1:8080",
		CAS_BASE_URL: "http://127.0.0.1:9080/cas/",
	});
}
function cookieOf(res, name) {
	return res.cookies.find((c) => c.name === name)?.value;
}
async function setup(
	t,
	fetchImpl = async () => new Response(xml()),
	overrides = {}
) {
	let time = Date.now();
	const auth = createCasAuth(
		{ ...config(), ...overrides },
		{ fetchImpl, now: () => time }
	);
	const app = Fastify();
	auth.register(app);
	app.get("/", () => "protected");
	app.get("/api/cacert", () => "protected certificate");
	t.after(() => app.close());
	return {
		app,
		auth,
		advance: (ms) => {
			time += ms;
		},
	};
}
async function begin(app) {
	const res = await app.inject("/auth/login");
	const login = new URL(res.headers.location);
	const service = new URL(login.searchParams.get("service"));
	return {
		service,
		cookie: `webvpn_login=${cookieOf(res, "webvpn_login")}`,
		res,
	};
}
async function login(app) {
	const flow = await begin(app);
	const response = await app.inject({
		url: flow.service.pathname + flow.service.search + "&ticket=ST-test",
		headers: { cookie: flow.cookie },
	});
	assert.equal(response.statusCode, 302);
	return `webvpn_session=${cookieOf(response, "webvpn_session")}`;
}
function socket() {
	const s = new EventEmitter();
	s.destroy = () => {
		s.destroyed = true;
		s.emit("close");
	};
	s.end = (value) => {
		s.denied = value;
	};
	return s;
}

test("production config rejects insecure endpoints and unsafe origins", () => {
	assert.throws(() => configFromEnv({}));
	assert.throws(() =>
		configFromEnv({ CAS_LOCAL_TEST: "1", APP_ORIGIN: "http://example.com" })
	);
	assert.throws(() => configFromEnv({ APP_ORIGIN: "https://vpn.example/a" }));
	assert.throws(() =>
		configFromEnv({
			APP_ORIGIN: "https://vpn.example",
			CAS_SESSION_SECONDS: "0",
		})
	);
	assert.equal(
		configFromEnv({ APP_ORIGIN: "https://vpn.example" }).cas,
		"https://cas.ncu.edu.cn:8443/cas/"
	);
});
test("XML namespace, entities, duplicate user, failure and bounds", () => {
	assert.equal(parseValidation(xml("student&amp;01")), "student&01");
	for (const body of [
		xml("").replace("authenticationSuccess", "authenticationFailure"),
		xml("").replaceAll("http://www.yale.edu/tp/cas", "https://evil"),
		xml("<cas:user>x</cas:user>"),
		xml().replace("</cas:user>", "</cas:user><cas:user>other</cas:user>"),
		'<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]>' + xml("&a;"),
		"not xml",
		"x".repeat(65537),
	])
		assert.throws(() => parseValidation(body));
});
test("unauthenticated HTTP routes and raw upgrade cannot bypass authentication", async (t) => {
	const { app, auth } = await setup(t);
	assert.equal((await app.inject("/")).headers.location, "/auth/login");
	for (const path of [
		"/api/cacert",
		"/web/https%3A%2F%2Fexample.com",
		"/scram/scramjet.all.js",
	])
		assert.equal((await app.inject(path)).statusCode, 401);
	const s = socket();
	assert.equal(
		auth.authorizeUpgrade(
			{ url: "/wisp/", headers: { origin: config().origin } },
			s
		),
		false
	);
	assert.match(s.denied, /401/);
});
test("valid login verifies exact service server-to-server and rotates to a session", async (t) => {
	let request;
	const { app } = await setup(t, async (url, options) => {
		request = { url, options };
		return new Response(xml());
	});
	const flow = await begin(app);
	const response = await app.inject({
		url: flow.service.pathname + flow.service.search + "&ticket=ST-test",
		headers: { cookie: flow.cookie },
	});
	assert.equal(response.statusCode, 302);
	assert.equal(request.url.href, "http://127.0.0.1:9080/cas/serviceValidate");
	assert.equal(request.options.body.get("service"), flow.service.href);
	assert.equal(request.options.method, "POST");
	assert.equal(request.options.redirect, "error");
	const session = cookieOf(response, "webvpn_session");
	assert.ok(session && !session.includes("student"));
	assert.ok(response.cookies.find((c) => c.name === "webvpn_session").httpOnly);
	const state = await app.inject({
		url: "/auth/session",
		headers: { cookie: `webvpn_session=${session}` },
	});
	assert.equal(state.json().username, "student01");
	assert.equal(state.headers["cache-control"], "no-store");
	assert.equal(
		(
			await app.inject({
				url: flow.service.pathname + flow.service.search + "&ticket=ST-test",
				headers: { cookie: flow.cookie },
			})
		).statusCode,
		400
	);
});
test("missing, wrong, duplicate or expired nonce rejected without validation", async (t) => {
	let calls = 0;
	const { app, advance } = await setup(t, async () => {
		calls++;
		return new Response(xml());
	});
	for (const kind of ["missing-cookie", "wrong", "duplicate", "expired"]) {
		const flow = await begin(app);
		if (kind === "wrong") flow.service.searchParams.set("nonce", "wrong");
		if (kind === "duplicate")
			flow.service.searchParams.append("nonce", "wrong");
		if (kind === "expired") advance(300001);
		const res = await app.inject({
			url: flow.service.pathname + flow.service.search + "&ticket=ST-test",
			headers: { cookie: kind === "missing-cookie" ? "" : flow.cookie },
		});
		assert.equal(res.statusCode, 400);
	}
	assert.equal(calls, 0);
});
test("CAS failures, network failures and oversized responses fail closed", async (t) => {
	for (const fetchImpl of [
		async () => new Response("failed", { status: 500 }),
		async () => {
			throw new Error("network");
		},
		async () =>
			new Response(
				xml().replaceAll("authenticationSuccess", "authenticationFailure")
			),
		async () => new Response("x".repeat(70000)),
	]) {
		const { app } = await setup(t, fetchImpl);
		const flow = await begin(app);
		const res = await app.inject({
			url: flow.service.pathname + flow.service.search + "&ticket=ST-test",
			headers: { cookie: flow.cookie },
		});
		assert.equal(res.statusCode, 502);
		assert.equal(cookieOf(res, "webvpn_session"), undefined);
	}
});
test("upgrade origin/path checks, logout CSRF and active socket revocation", async (t) => {
	const { app, auth } = await setup(t);
	const cookie = await login(app);
	for (const [url, origin] of [
		["/wisp/", "https://evil.example"],
		["/x/wisp/", config().origin],
		["/wisp/?x", config().origin],
	]) {
		assert.equal(
			auth.authorizeUpgrade({ url, headers: { cookie, origin } }, socket()),
			false
		);
	}
	const active = socket();
	assert.equal(
		auth.authorizeUpgrade(
			{ url: "/wisp/", headers: { cookie, origin: config().origin } },
			active
		),
		true
	);
	assert.equal(
		(
			await app.inject({
				method: "POST",
				url: "/auth/logout",
				headers: { cookie },
			})
		).statusCode,
		403
	);
	const account = await app.inject({
		url: "/auth/account",
		headers: { cookie },
	});
	assert.equal(account.headers["referrer-policy"], "same-origin");
	assert.match(
		account.headers["content-security-policy"],
		/form-action 'self' http:\/\/127.0.0.1:9080/
	);
	const csrf = account.body.match(/name="csrf" value="([^"]+)"/)[1];
	const res = await app.inject({
		method: "POST",
		url: "/auth/logout",
		headers: {
			cookie,
			origin: config().origin,
			"content-type": "application/x-www-form-urlencoded",
		},
		payload: `csrf=${csrf}`,
	});
	assert.equal(res.statusCode, 303);
	assert.match(res.headers.location, /\/cas\/logout\?/);
	assert.equal(active.destroyed, true);
	assert.equal(
		(await app.inject({ url: "/auth/session", headers: { cookie } }))
			.statusCode,
		401
	);
});
test("expired session cannot use HTTP or open WebSocket", async (t) => {
	const { app, auth, advance } = await setup(t);
	const cookie = await login(app),
		active = socket();
	auth.authorizeUpgrade(
		{ url: "/wisp/", headers: { cookie, origin: config().origin } },
		active
	);
	advance(3600001);
	assert.equal(
		(await app.inject({ url: "/", headers: { cookie } })).statusCode,
		302
	);
	assert.equal(active.destroyed, true);
	assert.equal(
		auth.authorizeUpgrade(
			{ url: "/wisp/", headers: { cookie, origin: config().origin } },
			socket()
		),
		false
	);
});

test("vendor JSONP logout rejects script injection and revokes socket/session", async (t) => {
	const { app, auth } = await setup(t);
	const cookie = await login(app),
		active = socket();
	auth.authorizeUpgrade(
		{ url: "/wisp/", headers: { cookie, origin: config().origin } },
		active
	);
	for (const url of [
		"/auth/slo",
		"/auth/slo?callback=x&callback=y",
		"/auth/slo?callback=alert(1)",
	]) {
		assert.equal(
			(await app.inject({ url, headers: { cookie } })).statusCode,
			400
		);
	}
	assert.equal(
		(await app.inject({ url: "/auth/session", headers: { cookie } }))
			.statusCode,
		200
	);
	const res = await app.inject({
		url: "/auth/slo?callback=jsonpcallback",
		headers: { cookie },
	});
	assert.equal(res.statusCode, 200);
	assert.equal(
		res.body,
		'jsonpcallback({"code":0,"message":null,"data":{"success":"注销成功"}});'
	);
	assert.equal(active.destroyed, true);
	assert.equal(
		(await app.inject({ url: "/auth/session", headers: { cookie } }))
			.statusCode,
		401
	);
});

test("online detection checks original ticket/service and revokes on offline or failure", async (t) => {
	for (const outcome of ["offline", "error", "malformed"]) {
		let alive = true,
			calls = 0;
		const { app, auth } = await setup(
			t,
			async (url, options) => {
				if (url.pathname.endsWith("serviceValidate"))
					return new Response(xml());
				calls++;
				assert.equal(url.pathname, "/cas/login/userOnlineDetect");
				assert.equal(options.body.get("ticket"), "ST-test");
				assert.equal(options.body.get("username"), "student01");
				assert.ok(
					new URL(options.body.get("service")).searchParams.has("nonce")
				);
				if (!alive && outcome === "error") throw new Error("unavailable");
				if (!alive && outcome === "malformed") return new Response("invalid");
				return Response.json({ code: 0, data: { isAlive: alive } });
			},
			{ onlineCheck: true }
		);
		const cookie = await login(app),
			active = socket();
		auth.authorizeUpgrade(
			{ url: "/wisp/", headers: { cookie, origin: config().origin } },
			active
		);
		await auth.checkOnline();
		assert.equal(
			(await app.inject({ url: "/auth/session", headers: { cookie } }))
				.statusCode,
			200
		);
		alive = false;
		await auth.checkOnline();
		assert.equal(calls, 2);
		assert.equal(active.destroyed, true);
		assert.equal(
			(await app.inject({ url: "/auth/session", headers: { cookie } }))
				.statusCode,
			401
		);
	}
});

test("production cookies enforce Secure, HttpOnly and host-only scope", async (t) => {
	const { app } = await setup(t, undefined, {
		local: false,
		origin: "https://vpn.example",
	});
	const start = await app.inject("/auth/login");
	const pending = start.cookies.find((c) => c.name === "__Host-webvpn_login");
	assert.ok(pending.secure && pending.httpOnly);
	assert.equal(pending.path, "/");
	assert.equal(pending.domain, undefined);
	const service = new URL(
		new URL(start.headers.location).searchParams.get("service")
	);
	const res = await app.inject({
		url: service.pathname + service.search + "&ticket=ST-test",
		headers: { cookie: `__Host-webvpn_login=${pending.value}` },
	});
	const session = res.cookies.find((c) => c.name === "__Host-webvpn_session");
	assert.ok(session.secure && session.httpOnly);
	assert.equal(session.sameSite, "Lax");
	assert.equal(session.domain, undefined);
});

test("remote HTTPS mock uses loopback validation without weakening cookies", async (t) => {
	const settings = configFromEnv({
		APP_ORIGIN: "https://vpn.example",
		CAS_BASE_URL: "https://vpn.example/cas/",
		CAS_MOCK_BACKEND_URL: "http://127.0.0.1:9080/cas/",
	});
	assert.equal(settings.local, false);
	for (const invalid of [
		"http://10.0.0.1/cas/",
		"http://localhost/cas/",
		"http://127.0.0.1/other",
		"http://u:p@127.0.0.1/cas/",
	])
		assert.throws(() =>
			configFromEnv({
				APP_ORIGIN: "https://vpn.example",
				CAS_MOCK_BACKEND_URL: invalid,
			})
		);
	let target;
	const { app } = await setup(
		t,
		async (url) => {
			target = url.href;
			return new Response(xml());
		},
		settings
	);
	const start = await app.inject("/auth/login");
	const external = new URL(start.headers.location);
	assert.equal(external.origin, "https://vpn.example");
	const service = new URL(external.searchParams.get("service"));
	const pending = cookieOf(start, "__Host-webvpn_login");
	const end = await app.inject({
		url: service.pathname + service.search + "&ticket=ST-test",
		headers: { cookie: `__Host-webvpn_login=${pending}` },
	});
	assert.equal(end.statusCode, 302);
	assert.equal(target, "http://127.0.0.1:9080/cas/serviceValidate");
	assert.equal(
		end.cookies.find((c) => c.name === "__Host-webvpn_session").secure,
		true
	);
});

test("many authenticated Wisp connections are allowed and all revoked on logout", async (t) => {
	const { app, auth } = await setup(t);
	const cookie = await login(app);
	const req = { url: "/wisp/", headers: { cookie, origin: config().origin } };
	const sockets = Array.from({ length: 100 }, socket);
	for (const s of sockets) assert.equal(auth.authorizeUpgrade(req, s), true);
	const wrong = socket();
	assert.equal(
		auth.authorizeUpgrade(
			{ ...req, headers: { cookie, origin: "https://wrong.example" } },
			wrong
		),
		false
	);
	assert.match(wrong.denied, /403 Forbidden/);
	const account = await app.inject({
		url: "/auth/account",
		headers: { cookie },
	});
	const csrf = account.body.match(/name="csrf" value="([^"]+)"/)[1];
	const result = await app.inject({
		method: "POST",
		url: "/auth/logout",
		headers: {
			cookie,
			origin: config().origin,
			"content-type": "application/x-www-form-urlencoded",
		},
		payload: `csrf=${csrf}`,
	});
	assert.equal(result.statusCode, 303);
	assert.ok(sockets.every((s) => s.destroyed));
	assert.equal(auth.authorizeUpgrade(req, socket()), false);
});
