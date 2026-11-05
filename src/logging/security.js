import { appendFileSync } from "node:fs";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const events = new Set([
 "login_failure", "logout_rejected",
 "access_denied", "proxy_rejected", "proxy_error", "application_error",
 "session_expired", "session_revoked", "service_started", "service_stopping",
]);
const clean = (value) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256) : null;

export function sourceIp(req, trustLoopbackProxy = false) {
 const peer = req?.socket?.remoteAddress || "";
 if (trustLoopbackProxy && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) {
  const forwarded = req.headers?.["x-real-ip"];
  if (typeof forwarded === "string" && isIP(forwarded)) return forwarded;
 }
 return isIP(peer) ? peer : null;
}

export function createSecurityLogger({ file = process.env.SECURITY_LOG_FILE, write = appendFileSync, fallback = (line) => console.log(line) } = {}) {
 let warnedAt = 0;
 return (event, fields = {}) => {
  if (!events.has(event)) return;
  // Explicit schema: never serialize request objects, URLs, tickets or errors.
  const record = {
   timestamp: new Date().toISOString(), event_id: randomUUID(),
   category: "authentication_security", app: "webvpn", host: hostname(), event,
   severity: ["warning", "error"].includes(fields.severity) ? fields.severity : "info",
   account: clean(fields.account), source_ip: isIP(fields.sourceIp || "") ? fields.sourceIp : null,
   result: ["success", "failure", "denied"].includes(fields.result) ? fields.result : null,
   reason: /^[a-z0-9_]{1,80}$/.test(fields.reason || "") ? fields.reason : null,
  };
  const line = JSON.stringify(record) + "\n";
  try {
   if (file) write(file, line, { encoding: "utf8", mode: 0o640 });
   else fallback("WEBVPN_SECURITY " + line.trimEnd());
  } catch {
   // Logging failures must not bypass authentication or crash request handling.
   fallback("WEBVPN_SECURITY " + line.trimEnd());
   if (Date.now() - warnedAt > 60000) {
    warnedAt = Date.now();
    console.error("[security-log] file write failed; using service journal");
   }
  }
 };
}
