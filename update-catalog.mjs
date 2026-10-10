#!/usr/bin/env node
/**
 * update-catalog — keep the group catalog inside rea-mcp-filter.mjs in sync
 * with the live `rea mcp` server, so a `rea update` never silently orphans
 * (removed) or hides (added) tools.
 *
 * It spawns the live server, lists tools, diffs them against the pinned
 * GROUPS block, assigns new tools to groups with keyword rules, and rewrites
 * the `BEGIN/END CATALOG` marker block in place — the rewrite is syntax
 * checked with `node --check` before being kept.
 *
 * Modes:
 *   --check            drift report only; exit 1 if catalog != live server
 *   --dry-run          report + proposed block; writes nothing
 *   (default)          rewrite the marker block in rea-mcp-filter.mjs
 * Options:
 *   --inventory-out <file>   also save the full live inventory (probe format)
 *   --filter <path>          filter file (default: rea-mcp-filter.mjs next to this script)
 *   --command <cmd>          live server command (default: rea)
 *   --args <args...>         live server args (default: mcp; consumes the rest of argv)
 *   --simulate-add a,b,c     treat names as newly added, demo the classifier (implies --dry-run)
 *   --force                  rewrite even when there is no drift
 *
 * New-tool classification is heuristic (keyword rules below, first match wins);
 * the script always prints where each tool landed so you can review and fix
 * misclassifications by hand. Existing group membership is never re-shuffled.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEGIN = "// === BEGIN CATALOG (managed by update-catalog.mjs — do not edit by hand) ===";
const END = "// === END CATALOG ===";

/** Ordered keyword rules for NEW tools only; first match wins, else `core`. */
const RULES = [
  [/(^|[^a-z])evm/, "evm"],
  [/web|browser|screenshot|webmcp|network_capture/, "web"],
  [/javascript|electron|source_map|reconstruction|semantics|export_shapes|source_to_bundle|runtime/, "js"],
  [/android|managed|swift|objc|interface_builder|keyed_archive|asset_catalog|dotnet|plist|classes|protocols/, "mobile"],
  [/firmware|unblob|binwalk|binary_layout|architectures|extract_artifact|extract_firmware|signature|codesign/, "firmware"],
  [/evidence|bundle|artifact/, "evidence"],
  [/native|macho|crash|process|dispatch_metadata|load_image|data_type|instruction|ui/, "native"],
  [/^binary_session$|^open_binary$|^close_binary$|^binary_overview$|^list_documents$|^current_document$|^current_address$|^current_procedure$|^goto_address$/, "session"],
];
const classify = (name) => {
  for (const [re, group] of RULES) if (re.test(name)) return { group, heuristic: true };
  return { group: "core", heuristic: false };
};

const parseArgs = (argv) => {
  const opts = { mode: "write", inventoryOut: null, filter: path.join(HERE, "rea-mcp-filter.mjs"), command: "rea", args: ["mcp"], simulateAdd: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.mode = "check";
    else if (a === "--dry-run") opts.mode = "dry-run";
    else if (a === "--inventory-out") opts.inventoryOut = path.resolve(argv[++i]);
    else if (a === "--filter") opts.filter = path.resolve(argv[++i]);
    else if (a === "--command") opts.command = argv[++i];
    else if (a === "--args") { opts.args = argv.slice(i + 1); i = argv.length; }
    else if (a === "--simulate-add") {
      opts.simulateAdd = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (opts.mode === "write") opts.mode = "dry-run";
    }
    else if (a === "--force") opts.force = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
};

/** Minimal stdio MCP client: initialize -> paginated tools/list -> kill. */
const fetchLiveTools = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; let stderr = ""; const pending = new Map();
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8"); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  child.on("error", reject);
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const rpc = (id, method, params) => new Promise((r) => { pending.set(id, r); send({ jsonrpc: "2.0", id, method, params }); })
    .then((m) => { if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`); return m.result; });
  (async () => {
    try {
      await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "update-catalog", version: "1" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools = []; let cursor;
      do { const list = await rpc(2, "tools/list", cursor ? { cursor } : {}); tools.push(...(list.tools ?? [])); cursor = list.nextCursor; } while (cursor);
      child.kill("SIGTERM"); resolve(tools);
    } catch (e) { child.kill("SIGTERM"); reject(e); }
  })();
});

const liveVersion = (command) => {
  const r = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${command} --version failed: ${r.stderr || r.error || "exit " + r.status}`);
  return (r.stdout || "").trim().split("\n")[0].trim();
};

const renderBlock = (groups, version) => {
  const lines = [BEGIN, `export const PINNED_REA_VERSION = ${JSON.stringify(version)};`, "export const GROUPS = {"];
  for (const [group, names] of Object.entries(groups)) {
    lines.push(`  ${group}: [`);
    for (let i = 0; i < names.length; i += 4) lines.push(`    ${names.slice(i, i + 4).map((n) => JSON.stringify(n)).join(", ")},`);
    lines.push("  ],");
  }
  lines.push("};", END);
  return lines.join("\n");
};

const rewriteBlock = (filterPath, newBlock) => {
  const text = readFileSync(filterPath, "utf8");
  const start = text.indexOf(BEGIN); const end = text.indexOf(END);
  if (start < 0 || end < 0 || end <= start) throw new Error(`${filterPath} is missing the BEGIN/END CATALOG markers`);
  const updated = text.slice(0, start) + newBlock + text.slice(end + END.length);
  const tmp = filterPath + ".new.mjs";
  writeFileSync(tmp, updated);
  const check = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  if (check.status !== 0) { unlinkSync(tmp); throw new Error(`rewritten catalog failed \`node --check\`:\n${check.stderr}`); }
  const backup = filterPath + ".bak"; renameSync(filterPath, backup); renameSync(tmp, filterPath); unlinkSync(backup);
};

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  const { GROUPS, PINNED_REA_VERSION } = await import(pathToFileURL(opts.filter).href);
  const tools = await fetchLiveTools(opts.command, opts.args);
  const version = liveVersion(opts.command);

  const liveNames = new Set(tools.map((t) => t.name));
  const catalogNames = new Set(Object.values(GROUPS).flat());
  const added = [...liveNames].filter((n) => !catalogNames.has(n)).sort();
  const removed = [...catalogNames].filter((n) => !liveNames.has(n)).sort();
  const simulated = opts.simulateAdd.filter((n) => !catalogNames.has(n) && !liveNames.has(n));

  // Build the new groups object: keep order/membership, append classified
  // additions, drop stale names.
  const groups = {};
  for (const [g, names] of Object.entries(GROUPS)) groups[g] = names.filter((n) => liveNames.has(n) || simulated.includes(n));
  const assignments = [];
  for (const name of [...added, ...simulated].sort()) {
    const { group, heuristic } = classify(name);
    if (!groups[group]) groups[group] = [];
    if (!groups[group].includes(name)) groups[group].push(name);
    assignments.push({ name, group, heuristic, simulated: simulated.includes(name) });
  }

  const versionDrift = version !== PINNED_REA_VERSION;
  const drift = added.length > 0 || removed.length > 0 || versionDrift || simulated.length > 0;

  const est = (c) => Math.round(c / 3.5);
  const chars = JSON.stringify(tools).length;
  console.log(JSON.stringify({
    live_server: { command: opts.command, args: opts.args, version, tools: tools.length, est_tokens: est(chars) },
    pinned_catalog: { version: PINNED_REA_VERSION, tools: catalogNames.size },
    drift: { added, removed, version_drift: versionDrift },
    new_tool_assignments: assignments.map((a) => `${a.name} -> ${a.group}${a.heuristic ? "" : " (default, review!)"}${a.simulated ? " [simulated]" : ""}`),
    per_group: Object.fromEntries(Object.entries(groups).map(([g, n]) => [g, n.length])),
  }, null, 2));

  if (opts.inventoryOut) {
    writeFileSync(opts.inventoryOut, JSON.stringify({ server: { cmd: opts.command, args: opts.args }, count: tools.length, chars, est_tokens: est(chars), tools }, null, 2));
    console.log(`\ninventory saved: ${opts.inventoryOut}`);
  }

  if (opts.mode === "check") {
    console.log(drift ? "\nDRIFT: the filter catalog no longer matches the live server — run update-catalog.mjs to rewrite it." : "\nno drift: pinned catalog matches the live server.");
    process.exit(drift ? 1 : 0);
  }

  const block = renderBlock(groups, version);
  if (opts.mode === "dry-run") { console.log("\nproposed block:\n\n" + block + "\n"); return; }
  if (!drift && !opts.force) { console.log("\nno drift and --force not set: nothing to rewrite."); return; }
  rewriteBlock(opts.filter, block);
  console.log(`\ncatalog rewritten in ${opts.filter} (syntax-checked with node --check).`);
  console.log("Review the new_tool_assignments above; move anything misclassified by hand.");
};

main().catch((e) => { console.error(`update-catalog: ${e.message}`); process.exit(1); });
