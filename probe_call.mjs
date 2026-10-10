#!/usr/bin/env node
// Call one allowed and one disallowed REA tool through the filter proxy.
import { spawn } from "node:child_process";
const child = spawn(process.argv[2] ?? "node", (process.argv[3] ?? "rea-mcp-filter.mjs").split(" "), { stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const pending = new Map();
child.stdout.on("data", (c) => {
  buf += c.toString("utf8"); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));
const rpc = (id, method, params) => new Promise((r) => { pending.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
for (const [id, name] of [[2, process.env.CALL_OK ?? "binary_session"], [3, process.env.CALL_NO ?? "inspect_web_page"]]) {
  const res = await rpc(id, "tools/call", { name, arguments: {} });
  console.log(`\n### ${name}\n${JSON.stringify(res.error ?? res.result, null, 2).slice(0, 900)}`);
}
child.kill("SIGTERM"); process.exit(0);
