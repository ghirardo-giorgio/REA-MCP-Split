# REA MCP Split — dividere il server MCP di REA per dominio

[morluto/rea](https://github.com/morluto/rea) espone **139 tool MCP** tramite `rea mcp`.
Registrare tutto il catalogo in un unico entry MCP significa che ogni sessione paga
l'elenco completo dei tool al modello: **≈ 534k token** (1.87M caratteri JSON,
misurato con REA 6.3.0) solo per la `tools/list`.

Questo repository contiene un **proxy stdio trasparente** (`rea-mcp-filter.mjs`) che
espone solo il sottoinsieme di tool che serve, più le probe per generare il catalogo
e verificare lo split. Così ogni entry MCP paga solo i token del dominio che usa:
il tronco `session,core` costa ≈ 163k token, una slice come `firmware` aggiunge
solo ≈ 20k token (≈ 183k in totale) contro i ≈ 534k del catalogo completo.

## File di questo repository

| File | Ruolo |
|---|---|
| [`rea-mcp-filter.mjs`](rea-mcp-filter.mjs) | Proxy MCP stdio: pipe trasparente verso `rea mcp`, filtra `tools/list` e intercetta `tools/call` dei tool disabilitati |
| [`probe_tools_list.mjs`](probe_tools_list.mjs) | Client MCP minimale: `initialize` + `tools/list` → salva l'inventario completo |
| [`probe_call.mjs`](probe_call.mjs) | Verifica dello split: chiama un tool consentito e uno disabilitato attraverso il proxy |
| [`rea_tools_inventory_full.json`](rea_tools_inventory_full.json) | Inventario completo dei 139 tool (generato con REA 6.3.0) |
| [`rea_tools_inventory.json`](rea_tools_inventory.json) | Snapshot generato *attraverso* il filtro (gruppo `firmware`, 7 tool) — esempio del risultato dello split |

## Prerequisiti

- Node.js ≥ 22 (qui testato con v24.13)
- REA installato: `npm install --global rea-agents` → verifica con `rea --version` (catalogo fissato a **6.3.0**)
- Per l'analisi nativa serve Hopper, Ghidra o IDA (vedi [docs/installation.md](https://github.com/morluto/rea/blob/main/docs/installation.md) di REA); JavaScript/Electron statico non richiede alcun engine

## Procedura — come fare lo split in 5 passi

### 1. Genera l'inventario completo

```bash
OUT=rea_tools_inventory_full.json node probe_tools_list.mjs rea mcp
```

Il probe fa `initialize` + `tools/list` paginata contro `rea mcp` e stampa
`count`, `chars` ed `est_tokens` (≈ chars / 3.5); il JSON contiene ogni tool con
il suo schema, quindi da lì puoi misurare il costo token di ogni singolo tool o gruppo.

### 2. Consulta il catalogo per dominio

```bash
node rea-mcp-filter.mjs --groups
```

Stampa l'appartenenza dei tool ai gruppi e quali sono attivi con la tua
configurazione. I gruppi (catalogo REA@6.3.0):

| Gruppo | Tool | Costo token (misurato) |
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
| **Totale** | **139** | **≈ 534k** |

*(stima ≈ caratteri JSON / 3.5, calcolata su `rea_tools_inventory_full.json`;
include gli `examples` embedded negli inputSchema, che sono solo ~7% del peso:
spogliandoli il catalogo resta ≈ 497k token, quindi i numeri sono robusti)*

Il costo delle split tipiche, rispetto al catalogo completo (534k token):

| Split | Tool | Token | Risparmio |
|---|---:|---:|---:|
| `session,core` (solo tronco) | 59 | ≈ 163k | −69% |
| `session,core,evm` | 60 | ≈ 166k | −69% |
| `session,core,evidence` | 64 | ≈ 175k | −67% |
| `session,core,firmware` | 66 | ≈ 183k | −66% |
| `session,core,native` | 75 | ≈ 229k | −57% |
| `session,core,mobile` | 79 | ≈ 233k | −56% |
| `session,core,web` | 74 | ≈ 254k | −52% |
| `session,core,js` | 75 | ≈ 274k | −49% |

### 3. Scegli lo split

Un entry MCP per profilo d'uso. `session` + `core` sono il **tronco comune**
(`open_binary`, `procedure_pseudo_code`, `xrefs`, …): le *fette* sono i gruppi
marginali. Esempi tipici:

| Profilo | `REA_MCP_GROUPS` |
|---|---|
| RE nativa (default del filtro) | `session,core,native` |
| Firmware | `session,core,firmware` |
| Electron / JavaScript | `session,core,js` |
| Browser / web | `session,core,web` |
| Android / .NET / managed | `session,core,mobile` |
| Apple bundle / inventari | `session,core,evidence` |
| EVM bytecode | `session,core,evm` |

Rifiniture con variabili d'ambiente (tutte opzionali):

| Variabile | Effetto |
|---|---|
| `REA_MCP_GROUPS` | gruppi da tenere (default: `session,core,native`) |
| `REA_MCP_TOOLS` | nomi o glob (`trace_*`) aggiuntivi, in aggiunta ai gruppi |
| `REA_MCP_EXCLUDE` | nomi o glob da togliere; **vince** su tutto |
| `REA_MCP_COMMAND` / `REA_MCP_ARGS` | comando figlio da spawnare (default: `rea mcp`) |
| `REA_MCP_ALL` | `1` = nessuna filtratura (catalogo completo) |

### 4. Registra il proxy nel tuo MCP client

Esempio DSH (patch layer del profilo, es. `~/.dsh/profiles/web/cordis.patch.yml`) —
un entry per slice:

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

Esempio generico (`.mcp.json` per Claude Code / Cursor / ecc.):

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

### 5. Verifica lo split

```bash
CALL_OK=binary_session CALL_NO=inspect_web_page node probe_call.mjs node rea-mcp-filter.mjs
```

Con i gruppi default (`session,core,native`) ci si aspetta — output reale di
questa verifica, REA 6.3.0 su Linux x64:

- `binary_session` → risposta normale dal server REA (capabilities, host facts…);
- `inspect_web_page` → errore `-32601` generato dal proxy:

```json
{
  "code": -32601,
  "message": "rea-mcp-filter: tool \"inspect_web_page\" is not enabled (groups: session, core, native). Enable it with REA_MCP_GROUPS/REA_MCP_TOOLS, or call rea-mcp-filter --groups to see the catalog."
}
```

## Come funziona il proxy

- È una **pipe JSON-RPC a righe** (stdio newline-delimited) verso `rea mcp`;
  `initialize`, prompts, resources, ping e notifiche passano byte-for-byte.
- Due soli interventi:
  1. le risposte a `tools/list` vengono filtrate per allowlist (tracciate per
     request-id);
  2. `tools/call` verso un tool fuori allowlist riceve `-32601` **risposto
     localmente**, così il figlio non vede mai un tool di cui il modello non sa
     nulla.
- `SIGTERM`/`SIGINT`/`SIGHUP` vengono inoltrati al figlio e il proxy esce:
  senza questo, il grandchild `rea mcp` (~330 MB) sopravviverebbe al proxy.

## Manutenzione

- Il catalogo `GROUPS` dentro `rea-mcp-filter.mjs` è **fissato a REA@6.3.0**.
  Dopo un `rea update`: rigenera l'inventario (passo 1), diffa i nomi dei tool
  con `GROUPS` e aggiornalo.
- Tool nuovi non assegnati a nessun gruppo restano invisibili finché non li
  aggiungi a `GROUPS` (o usi `REA_MCP_TOOLS` / `REA_MCP_ALL=1`).

## Riferimenti

- Repository REA: <https://github.com/morluto/rea>
- Catalogo tool ufficiale: [docs/mcp-contracts.md#generated-catalog](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md#generated-catalog)
- Sito e guide: <https://rea.tools/>
