#!/usr/bin/env node
// Minimal stdio MCP client: spawn `rea mcp`, initialize, list tools, dump inventory.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const cmd = process.argv[2] ?? "rea";
const args = (process.argv[3] ?? "mcp").split(" ");

const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
const notifications = [];

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      notifications.push(msg.method);
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(d));

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const rpc = (id, method, params) =>
  new Promise((resolve) => pending.set(id, resolve)).then((msg) => {
    if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  });
const request = (id, method, params) => { send({ jsonrpc: "2.0", id, method, params }); return rpc(id, method, params); };

const tools = [];
let cursor;
do {
  const list = await request(2, "tools/list", cursor ? { cursor } : {});
  tools.push(...(list.tools ?? []));
  cursor = list.nextCursor;
} while (cursor);

// Rough token estimate: 1 token ~= 3.5 chars for JSON-heavy English text.
const chars = JSON.stringify(tools).length;
const perTool = tools.map((t) => ({
  name: t.name,
  chars: JSON.stringify(t).length,
  desc_chars: (t.description ?? "").length,
}));

writeFileSync(
  process.env.OUT ?? "rea_tools_inventory.json",
  JSON.stringify({ server: { cmd, args }, count: tools.length, chars, est_tokens: Math.round(chars / 3.5), tools }, null, 2),
);

console.log(JSON.stringify({
  count: tools.length,
  chars,
  est_tokens: Math.round(chars / 3.5),
  notifications,
  top20: perTool.sort((a, b) => b.chars - a.chars).slice(0, 20),
}, null, 2));

child.kill("SIGTERM");
process.exit(0);
