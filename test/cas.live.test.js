// Requires npm run mock:cas and npm run dev:cas. Uses fictional accounts only.
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const origin = "http://127.0.0.1:8080";
const request = (url, options = {}) =>
	fetch(url, { redirect: "manual", ...options });
const cookie = (response, name) =>
	response.headers
		.getSetCookie()
		.find((value) => value.startsWith(name + "="))
		?.split(";")[0];

test(
	"live mock CAS, protected assets, Wisp handshake, logout disconnect",
	{ timeout: 15000 },
	async () => {
		const anonymous = await request(origin + "/sw.js");
		assert.equal(anonymous.status, 401);
		const denied = new WebSocket("ws://127.0.0.1:8080/wisp/", { origin });
		await new Promise((resolve, reject) => {
			denied.on("unexpected-response", (_req, res) => {
				assert.equal(res.statusCode, 401);
				res.resume();
				denied.terminate();
				resolve();
			});
			denied.on("open", () => {
				denied.terminate();
				reject(new Error("Unauthenticated Wisp accepted"));
			});
			denied.on("error", () => {});
		});
		const start = await request(origin + "/auth/login");
		const pending = cookie(start, "webvpn_login");
		const mock = new URL(start.headers.get("location"));
		assert.equal(mock.origin, "http://127.0.0.1:9080");
		mock.searchParams.set("demo", "1");
		const ticket = await request(mock);
		const signedIn = await request(ticket.headers.get("location"), {
			headers: { cookie: pending },
		});
		assert.equal(signedIn.status, 302);
		const session = cookie(signedIn, "webvpn_session");
		assert.ok(session);
		const headers = { cookie: session };
		assert.equal((await request(origin + "/sw.js", { headers })).status, 200);
		assert.equal(
			(await (await request(origin + "/auth/session", { headers })).json())
				.username,
			"student-demo"
		);
		const socket = new WebSocket("ws://127.0.0.1:8080/wisp/", {
			origin,
			headers,
		});
		try {
			await new Promise((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			});
			const closed = new Promise((resolve) => socket.once("close", resolve));
			const page = await (
				await request(origin + "/auth/account", { headers })
			).text();
			const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
			const result = await request(origin + "/auth/logout", {
				method: "POST",
				headers: {
					...headers,
					origin,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ csrf }),
			});
			assert.equal(result.status, 303);
			await closed;
			assert.equal(
				(await request(origin + "/auth/session", { headers })).status,
				401
			);
		} finally {
			socket.terminate();
		}
	}
);
