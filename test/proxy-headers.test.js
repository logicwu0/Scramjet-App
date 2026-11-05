import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const context = { self: {}, TextEncoder };
vm.runInNewContext(readFileSync(new URL("../public/proxy-headers.js", import.meta.url), "utf8"), context);
const normalize = context.self.webvpnNormalizeProxyHeaders;

test("decoded Unicode cookies can pass Request construction after normalization", () => {
	const headers = { Cookie: "pref=中文😀; token=abc%2Fdef", Authorization: "Bearer unchanged" };
	assert.throws(() => new Request("https://example.org/", { headers }), TypeError);
	normalize(headers);
	const request = new Request("https://example.org/", { headers });
	assert.equal(request.headers.get("cookie"), "pref=%E4%B8%AD%E6%96%87%F0%9F%98%80; token=abc%2Fdef");
	assert.equal(headers.Authorization, "Bearer unchanged");
	const once = headers.Cookie;
	normalize(headers);
	assert.equal(headers.Cookie, once);
});

test("valid headers remain untouched and unsupported headers are not silently changed", () => {
	const headers = { cookie: "a=one; b=%E4%B8%AD; c=é", "X-Name": "中文" };
	const before = { ...headers };
	assert.equal(normalize(headers).length, 0);
	assert.deepEqual(headers, before);
});
