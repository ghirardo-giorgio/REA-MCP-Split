# REA MCP Split — slicing REA's MCP server by domain

[Italiano](README.it.md) · **English**

[morluto/rea](https://github.com/morluto/rea) exposes **139 MCP tools** through `rea mcp`.
Registering the whole catalog in a single MCP entry means every session pays the
full tool list to the model: **≈ 534k tokens** (1.87M JSON characters, measured
with REA 6.3.0) just for the `tools/list`.

This repository ships a **transparent stdio proxy** (`rea-mcp-filter.mjs`) that
exposes only the subset of tools you need, plus the probes to generate the catalog
and verify the split. Each MCP entry then pays only for the domain it actually
uses: the `session,core` trunk costs ≈ 163k tokens, a `firmware` slice adds just
≈ 20k tokens (≈ 183k in total) versus the ≈ 534k of the full catalog.

## Files in this repository

| File | Role |
|---|---|
| [`rea-mcp-filter.mjs`](rea-mcp-filter.mjs) | MCP stdio proxy: transparent pipe to `rea mcp`, filters `tools/list` and intercepts `tools/call` for disabled tools |
| [`probe_tools_list.mjs`](probe_tools_list.mjs) | Minimal MCP client: `initialize` + `tools/list` → saves the full inventory |
| [`probe_call.mjs`](probe_call.mjs) | Split verification: calls one allowed and one disallowed tool through the proxy |
| [`rea_tools_inventory_full.json`](rea_tools_inventory_full.json) | Full inventory of the 139 tools (generated with REA 6.3.0) |
| [`rea_tools_inventory.json`](rea_tools_inventory.json) | Snapshot generated *through* the filter (`firmware` group, 7 tools) — an example of the split result |

## Prerequisites

- Node.js ≥ 22 (tested here with v24.13)
- REA installed: `npm install --global rea-agents` → verify with `rea --version` (catalog pinned to **6.3.0**)
- Native analysis needs Hopper, Ghidra or IDA (see REA's [docs/installation.md](https://github.com/morluto/rea/blob/main/docs/installation.md)); static JavaScript/Electron analysis requires no analysis engine

## Procedure — how to do the split in 5 steps

### 1. Generate the full inventory

```bash
OUT=rea_tools_inventory_full.json node probe_tools_list.mjs rea mcp
```

The probe runs `initialize` + paginated `tools/list` against `rea mcp` and prints
`count`, `chars` and `est_tokens` (≈ chars / 3.5); the JSON contains every tool
with its schema, so from it you can measure the token cost of any single tool or group.

### 2. Consult the per-domain catalog

```bash
node rea-mcp-filter.mjs --groups
```

Prints tool group membership and which groups are active with your configuration.
The groups (REA@6.3.0 catalog):

| Group | Tools | Measured token cost |
|---|---:|---:|
| `session` | 4 | ≈ 8.7k |
| `core` | 55 | ≈ 155k |
| `native` | 16 | ≈ 66k |
| `evidence` | 5 | ≈ 11k |
| `web` | 15 | ≈ 91k |
| `js` | 16 | ≈ 111k |
| `mobile` | 20 | ≈ 70k |
| `firmware` | 7 | ≈ 20k |
| `evm` | 1 | ≈ 2.5k |
| **Total** | **139** | **≈ 534k** |

*(estimate ≈ JSON characters / 3.5, computed on `rea_tools_inventory_full.json`;
includes the `examples` embedded in the inputSchemas, which are only ~7% of the
weight: stripped, the catalog still weighs ≈ 497k tokens, so the numbers are robust)*

Cost of typical splits, compared to the full catalog (534k tokens):

| Split | Tools | Tokens | Savings |
|---|---:|---:|---:|
| `session,core` (trunk only) | 59 | ≈ 163k | −69% |
| `session,core,evm` | 60 | ≈ 166k | −69% |
| `session,core,evidence` | 64 | ≈ 175k | −67% |
| `session,core,firmware` | 66 | ≈ 183k | −66% |
| `session,core,native` | 75 | ≈ 229k | −57% |
| `session,core,mobile` | 79 | ≈ 233k | −56% |
| `session,core,web` | 74 | ≈ 254k | −52% |
| `session,core,js` | 75 | ≈ 274k | −49% |

### 3. Choose the split

One MCP entry per usage profile. `session` + `core` are the **common trunk**
(`open_binary`, `procedure_pseudo_code`, `xrefs`, …): the *slices* are the
marginal groups. Typical examples:

| Profile | `REA_MCP_GROUPS` |
|---|---|
| Native RE (filter default) | `session,core,native` |
| Firmware | `session,core,firmware` |
| Electron / JavaScript | `session,core,js` |
| Browser / web | `session,core,web` |
| Android / .NET / managed | `session,core,mobile` |
| Apple bundles / inventories | `session,core,evidence` |
| EVM bytecode | `session,core,evm` |

Fine-tuning with environment variables (all optional):

| Variable | Effect |
|---|---|
| `REA_MCP_GROUPS` | groups to keep (default: `session,core,native`) |
| `REA_MCP_TOOLS` | extra tool names or globs (`trace_*`), added on top of the groups |
| `REA_MCP_EXCLUDE` | names or globs to drop; **wins** over everything |
| `REA_MCP_COMMAND` / `REA_MCP_ARGS` | child command to spawn (default: `rea mcp`) |
| `REA_MCP_ALL` | `1` = no filtering at all (full catalog) |

### 4. Register the proxy in your MCP client

DSH example (profile patch layer, e.g. `~/.dsh/profiles/web/cordis.patch.yml`) —
one entry per slice:

```yaml
- insert:
    id: mcp-rea-native
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: rea-native
      transport: stdio
      command: node
      args: ["/home/oberon/.dsh/scripts/rea-mcp-filter.mjs"]
      env:
        REA_MCP_GROUPS: session,core,native
```

Generic example (`.mcp.json` for Claude Code / Cursor / etc.):

```json
{
  "mcpServers": {
    "rea-native": {
      "command": "node",
      "args": ["/path/to/rea-mcp-filter.mjs"],
      "env": { "REA_MCP_GROUPS": "session,core,native" }
    },
    "rea-firmware": {
      "command": "node",
      "args": ["/path/to/rea-mcp-filter.mjs"],
      "env": { "REA_MCP_GROUPS": "session,core,firmware" }
    }
  }
}
```

### 5. Verify the split

```bash
CALL_OK=binary_session CALL_NO=inspect_web_page node probe_call.mjs node rea-mcp-filter.mjs
```

With the default groups (`session,core,native`) you should get — real output of
this verification, REA 6.3.0 on Linux x64:

- `binary_session` → normal response from the REA server (capabilities, host facts…);
- `inspect_web_page` → `-32601` error generated by the proxy:

```json
{
  "code": -32601,
  "message": "rea-mcp-filter: tool \"inspect_web_page\" is not enabled (groups: session, core, native). Enable it with REA_MCP_GROUPS/REA_MCP_TOOLS, or call rea-mcp-filter --groups to see the catalog."
}
```

## How the proxy works

- It is a **line-based JSON-RPC pipe** (newline-delimited stdio) to `rea mcp`;
  `initialize`, prompts, resources, ping and notifications pass byte-for-byte.
- Only two interventions:
  1. `tools/list` responses are filtered by allowlist (tracked by request-id);
  2. `tools/call` for a tool outside the allowlist gets `-32601` **answered
     locally**, so the child never sees a tool the model was never told about.
- `SIGTERM`/`SIGINT`/`SIGHUP` are forwarded to the child and the proxy exits:
  without this, the ~330 MB `rea mcp` grandchild would outlive the proxy.

## Maintenance

- The `GROUPS` catalog inside `rea-mcp-filter.mjs` is **pinned to REA@6.3.0**.
  After a `rea update`: regenerate the inventory (step 1), diff the tool names
  against `GROUPS` and update it.
- New tools not assigned to any group stay invisible until you add them to
  `GROUPS` (or use `REA_MCP_TOOLS` / `REA_MCP_ALL=1`).

## License

[MIT](LICENSE)

## References

- REA repository: <https://github.com/morluto/rea>
- Official tool catalog: [docs/mcp-contracts.md#generated-catalog](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md#generated-catalog)
- Website and guides: <https://rea.tools/>
