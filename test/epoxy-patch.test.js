import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../node_modules/@mercuryworkshop/epoxy-transport/dist/index.mjs", import.meta.url), "utf8");
const start = code.indexOf("  async request(remote, method, body, headers, signal) {");
assert.ok(start > 0);
const end = code.indexOf("\n  connect(", start);
assert.ok(end > start);
const transport = vm.runInNewContext("({" + code.slice(start, end) + "})", { Blob, ReadableStream, Response, console: {log(){}, error(){}} });

test("MathSciNet Set-Cookie filtering matches main, other origins retain cookies", async () => {
 const rawHeaders = { "Set-Cookie": ["session=test; Path=/"], "content-type": "text/html" };
 transport.client = { fetch: async () => ({rawHeaders, status:200,statusText:"OK",body:new Uint8Array([65]).buffer}) };
 const result = await transport.request(new URL("https://mathscinet.ams.org/"), "GET");
 assert.equal(Object.keys(result.headers).some(k=>k.toLowerCase()==="set-cookie"), false);
 assert.equal(result.headers["content-type"], "text/html");
 for(const host of ["www.google.com", "accounts.google.com", "other.mathscinet.ams.org"]) {
  const r = await transport.request(new URL("https://"+host+"/"), "GET");
  assert.deepEqual(r.headers["Set-Cookie"], rawHeaders["Set-Cookie"]);
 }
 assert.ok(rawHeaders["Set-Cookie"], "do not mutate original response");
});
