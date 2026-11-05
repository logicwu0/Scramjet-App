import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

const clean = (value) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256) : null;

// Access records go only to the configured local file, never to Syslog/stdout.
export function createAccessLogger({ file = process.env.ACCESS_LOG_FILE, write = appendFileSync } = {}) {
 let warnedAt = 0;
 return (fields) => {
  if (!file) return;
  const row = {
   timestamp: new Date().toISOString(), event_id: randomUUID(), category: "access",
   account: clean(fields.account), source_ip: isIP(fields.sourceIp || "") ? fields.sourceIp : null,
   target_host: clean(fields.targetHost), target_port: fields.targetPort,
   protocol: fields.protocol, result: fields.result, reason: fields.reason || null,
  };
  try { write(file, JSON.stringify(row) + "\n", { encoding: "utf8", mode: 0o640 }); }
  catch {
   if (Date.now() - warnedAt > 60000) {
    warnedAt = Date.now();
    console.error("[access-log] local write failed; access record not forwarded");
   }
  }
 };
}

// Per-connection classes use Wisp's TCPSocket/UDPSocket options. No global
// account state, protocol rewrites, or dependency modifications are needed.
export function auditedSocket(Base, protocol, context, log) {
 return class extends Base {
  constructor(host, port) {
   super(host, port);
   this.accessRecorded = false;
  }
  recordAccess(result, reason) {
   if (this.accessRecorded) return;
   this.accessRecorded = true;
   log({ ...context, targetHost: this.hostname, targetPort: this.port, protocol, result, reason });
  }
  async connect() {
   try {
    await super.connect();
    this.recordAccess("connected");
   } catch (error) {
    this.recordAccess("failed", "connection_failed");
    throw error;
   }
  }
  async close() {
   this.recordAccess("not_established", "closed_before_connect");
   return super.close();
  }
 };
}
