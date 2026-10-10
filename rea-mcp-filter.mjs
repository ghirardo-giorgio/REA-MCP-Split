#!/usr/bin/env node
/**
 * rea-mcp-filter — thin stdio MCP proxy that exposes only a chosen subset of
 * REA's 139 MCP tools, so each DSH entry pays tokens only for the domains it
 * actually uses.
 *
 * It is a transparent JSON-RPC pipe to `rea mcp` (stdio) with two interventions:
 *   1. `tools/list` responses are filtered to the allowlist.
 *   2. `tools/call` for a tool outside the allowlist is answered locally,
 *      so the child never sees a tool the model was never told about.
 * Everything else (initialize, prompts, resources, notifications, ping) is
 * forwarded byte-for-byte in both directions.
 *
 * Config (environment):
 *   REA_MCP_GROUPS   comma-separated groups to keep. Default: core,native
 *   REA_MCP_TOOLS    extra tool names or glob patterns to keep (additive)
 *   REA_MCP_EXCLUDE  tool names or glob patterns to drop (subtractive, wins)
 *   REA_MCP_COMMAND  command to spawn. Default: rea
 *   REA_MCP_ARGS     space-separated args. Default: mcp
 *   REA_MCP_ALL      set to 1 to disable filtering entirely
 * Run with `--groups` to print the catalog, group membership and token cost.
 */
import { spawn } from "node:child_process";

/** Canonical REA@6.3.0 tool catalog, grouped by domain. */
export const GROUPS = {
  session: [
    "binary_session", "binary_overview", "open_binary", "close_binary",
  ],
  core: [
    "address_name", "address_to_file_offset", "analyze_function", "batch_decompile",
    "comment", "current_address", "current_document", "current_procedure",
    "find_xrefs_to_name", "get_call_graph", "get_navigation_context",
    "goto_address", "inline_comment", "inspect_address_context",
    "inspect_analysis_view", "list_bookmarks", "list_documents", "list_names",
    "list_procedures", "list_segments", "list_strings", "list_unknowns",
    "next_address", "prev_address", "procedure_address", "procedure_assembly",
    "procedure_callees", "procedure_callers", "procedure_info",
    "procedure_pseudo_code", "procedure_references", "read_bytes",
    "read_function_instructions", "record_unknown", "resolve_containing_procedure",
    "search_procedures", "search_strings", "set_address_name",
    "set_addresses_names", "set_bookmark", "set_comment", "set_inline_comment",
    "trace_call_path", "trace_dylib_resolution", "trace_feature",
    "trace_application_feature", "unset_bookmark", "update_unknown",
    "verify_unknown_resolution", "xrefs",
    // comparison / graph projection over opened targets
    "build_call_path", "compare_application_versions", "compare_functions",
    "find_changed_behavior", "project_apple_application_graph",
  ],
  native: [
    "annotate_native_function", "capture_native_ui_scenario", "capture_process_scenario",
    "compare_process_captures", "inspect_macho", "inspect_native_api",
    "inspect_native_data_type", "inspect_native_dispatch_metadata",
    "inspect_native_instruction", "inspect_native_load_image",
    "inspect_recorded_crash", "observe_native_calls", "observe_native_ui",
    "resolve_native_call_targets", "trace_native_ui_action", "trace_native_values",
  ],
  evidence: [
    "export_evidence_bundle", "get_evidence_bundle", "import_evidence_bundle",
    "compare_artifacts", "compare_bundles",
  ],
  web: [
    "analyze_web_bundle", "capture_browser_scenario", "capture_web_screenshot",
    "compare_web_captures", "compare_web_screenshots", "discover_webmcp_tools",
    "export_web_scripts", "inspect_web_event_listeners",
    "inspect_web_network_capture", "inspect_web_page", "list_browser_targets",
    "observe_web_execution", "observe_web_session", "trace_web_module_imports",
    "trace_web_source_location",
  ],
  js: [
    "analyze_javascript_application", "capture_electron_scenario",
    "compare_javascript_export_shapes", "compare_source_to_bundle",
    "correlate_static_and_runtime", "evaluate_reconstruction_coverage",
    "build_reconstruction_obligation_ledger", "import_managed_reconstruction",
    "inspect_electron_page", "list_electron_targets",
    "list_javascript_runtime_targets", "observe_javascript_runtime",
    "reconcile_javascript_runtime", "recover_javascript_sources",
    "trace_javascript_semantics", "verify_reconstruction",
  ],
  mobile: [
    "analyze_swift_types", "compare_managed_members", "decode_interface_builder",
    "demangle_swift", "get_objc_classes", "get_objc_protocols",
    "inspect_android_class", "inspect_android_method", "inspect_android_package",
    "inspect_asset_catalog", "inspect_keyed_archive", "inspect_managed_artifact",
    "inspect_managed_members", "inspect_managed_native_boundaries", "inspect_plist",
    "project_android_application_graph", "project_managed_application_graph",
    "search_android_classes", "trace_android_references",
    "verify_managed_native_boundaries",
  ],
  firmware: [
    "extract_artifact", "extract_firmware", "inspect_artifact",
    "inspect_binary_layout", "inspect_firmware_regions", "inspect_signature",
    "list_architectures",
  ],
  evm: ["inspect_evm_interface"],
};

const DEFAULT_GROUPS = "session,core,native";

const toRegex = (pattern) =>
  new RegExp(`^${pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

const buildAllowlist = (env) => {
  const all = env.REA_MCP_ALL === "1";
  const groups = (env.REA_MCP_GROUPS ?? DEFAULT_GROUPS).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = groups.filter((g) => !(g in GROUPS));
  if (unknown.length) {
    process.stderr.write(`rea-mcp-filter: unknown group(s): ${unknown.join(", ")} — known: ${Object.keys(GROUPS).join(", ")}\n`);
  }
  const keep = new Set();
  for (const g of groups) for (const name of GROUPS[g] ?? []) keep.add(name);
  const patterns = (env.REA_MCP_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(toRegex);
  const drops = (env.REA_MCP_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(toRegex);
  return {
    all,
    groups,
    allows: (name) =>
      drops.some((re) => re.test(name)) ? false
        : all ? true
        : keep.has(name) || patterns.some((re) => re.test(name)),
  };
};

const estimateTokens = (value) => Math.round(JSON.stringify(value).length / 3.5);

/** `--groups`: print catalog membership and per-group token cost, then exit. */
if (process.argv.includes("--groups") || process.argv.includes("--list-groups")) {
  const allow = buildAllowlist(process.env);
  const rows = Object.entries(GROUPS).map(([g, names]) => ({
    group: g,
    tools: names.length,
    enabled: allow.groups.includes(g),
  }));
  process.stdout.write(JSON.stringify({ default_groups: DEFAULT_GROUPS, groups: rows, total_tools: Object.values(GROUPS).flat().length }, null, 2) + "\n");
  process.exit(0);
}

const allow = buildAllowlist(process.env);
const command = process.env.REA_MCP_COMMAND ?? "rea";
const args = (process.env.REA_MCP_ARGS ?? "mcp").split(" ").filter(Boolean);

const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
child.on("error", (error) => {
  process.stderr.write(`rea-mcp-filter: cannot spawn ${command}: ${error.message}\n`);
  process.exit(1);
});

// ids of in-flight tools/list requests, so their responses can be filtered.
const listRequestIds = new Set();

const writeLine = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

const parseLine = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

// client -> server
let inBuf = "";
process.stdin.on("data", (chunk) => {
  inBuf += chunk.toString("utf8");
  let idx;
  while ((idx = inBuf.indexOf("\n")) >= 0) {
    const raw = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    const trimmed = raw.trim();
    if (!trimmed) { child.stdin.write("\n"); continue; }
    const msg = parseLine(trimmed);
    if (!msg) { child.stdin.write(`${raw}\n`); continue; }
    if (msg.method === "tools/list") {
      if (msg.id !== undefined) listRequestIds.add(msg.id);
      writeLine(msg);
      continue;
    }
    if (msg.method === "tools/call" && !allow.allows(String(msg.params?.name ?? ""))) {
      const groups = allow.groups.length ? ` (groups: ${allow.groups.join(", ")})` : "";
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0", id: msg.id ?? null,
        error: {
          code: -32601,
          message: `rea-mcp-filter: tool "${msg.params?.name}" is not enabled${groups}. Enable it with REA_MCP_GROUPS/REA_MCP_TOOLS, or call rea-mcp-filter --groups to see the catalog.`,
        },
      })}\n`);
      continue;
    }
    writeLine(msg);
  }
});
process.stdin.on("end", () => child.stdin.end());
process.stdin.on("close", () => child.kill("SIGTERM"));

// server -> client
let outBuf = "";
child.stdout.on("data", (chunk) => {
  outBuf += chunk.toString("utf8");
  let idx;
  while ((idx = outBuf.indexOf("\n")) >= 0) {
    const raw = outBuf.slice(0, idx);
    outBuf = outBuf.slice(idx + 1);
    const trimmed = raw.trim();
    if (!trimmed) { process.stdout.write("\n"); continue; }
    const msg = parseLine(trimmed);
    if (msg && msg.id !== undefined && listRequestIds.has(msg.id)) {
      listRequestIds.delete(msg.id);
      const tools = (msg.result?.tools ?? []).filter((tool) => allow.allows(String(tool.name ?? "")));
      process.stdout.write(`${JSON.stringify({ ...msg, result: { ...msg.result, tools } })}\n`);
      continue;
    }
    process.stdout.write(`${raw}\n`);
  }
});
child.stdout.on("end", () => process.stdout.end());

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code, signal) => {
  if (!process.stdout.writableEnded) process.stdout.end();
  process.exitCode = code ?? (signal ? 1 : 0);
});

// Forward termination so the ~330 MB `rea mcp` grandchild never outlives the
// proxy (DSH kills the stdio probe process, and node does not reap children).
// Installing a handler replaces node's default terminate action, so the proxy
// must exit itself after forwarding the signal.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(0);
  });
}
process.on("exit", () => {
  if (!child.killed) child.kill("SIGTERM");
});
