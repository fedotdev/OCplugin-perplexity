# opencode-plugin-perplexity

[![Build Status](https://img.shields.io/badge/bun-test-blue?style=flat-square&logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-1.18.25-purple?style=flat-square)](https://opencode.ai)

OpenCode plugin that registers a single tool — perplexity_research — to search Perplexity via your logged-in Chrome/Thorium profile and the **OpenCLI Browser Bridge**.
Perfect if you want to leverage Perplexity features without paying for a separate Perplexity API key. It uses your active browser session directly — whether you're on the free tier or have an active Pro subscription (recommended for advanced models and deeper research).

> [!IMPORTANT]
> This plugin is a thin wrapper around an external CLI process (`opencli perplexity ask`). It has **no network access of its own**. All browsing, authentication, and DOM extraction happen inside your real browser tab via OpenCLI's local daemon and the Browser Bridge MV3 extension.

---

## Architecture

```
OpenCode Plugin
  └─ $`opencli perplexity ask "..." --format json --output /tmp/result.json`
       │
       │  HTTP POST http://127.0.0.1:19825/command
       ▼
   Local daemon (port 19825) — pending-command map
       │  WebSocket ws://localhost:19825/ext
       ▼
   Browser Bridge MV3 extension (Chrome/Thorium)
       │  chrome.debugger CDP (attach "1.3", Runtime.evaluate)
       ▼
   Chrome tab: www.perplexity.ai — real cookies, real session
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Search & Deep Research** | `search` (default) or `deep_research` mode via Perplexity composer |
| **Browser-based auth** | Uses cookies from your real Chrome profile — no API keys, no tokens |
| **Trusted source tagging** | `allowedDomains` marks sources as `trusted: true/false` via hostname suffix match |
| **Structured sources** | Title, URL, ISO timestamp; TeX math extracted as clean LaTeX, tables as Markdown |
| **JSONL tracing** | Every call logged with question, exit code, elapsed ms, source count, trace ID |
| **Typed errors** | Friendly Russian messages for `AUTH_REQUIRED`, `BROWSER_CONNECT`, `SESSION_BUSY`, `TIMEOUT` |
| **Zero trust output** | Every response prefixed with **НЕДОВЕРЕННЫЕ ДАННЫЕ** disclaimer |

---

## Prerequisites

Before using the plugin, ensure you have:

1. **OpenCLI** installed and daemon running (`opencli doctor`)
2. **Browser Bridge MV3 extension** installed in Chrome/Thorium and connected (`opencli doctor` shows green)
3. **Authorized Chrome profile** with an active `perplexity.ai` session (`opencli profile list` → `opencli profile rename <id> research`)
4. **Bun ≥ 1.2** (for running tests and building)

> [!TIP]
> If the "Stop" button disappears before the answer fully renders, kill all Chrome/Thorium processes and restart cleanly — this is the most common fix for timeouts.

---

## Installation

### 1. Install the OpenCLI adapter (one-time)

The public OpenCLI registry does not include a `perplexity` adapter (only `gemini`), so it ships in this repo.

```bash
# From the repo root
bun install
bun run adapter:install    # copies adapter/perplexity → ~/.opencli/clis/perplexity/

# Verify
opencli list
opencli doctor
opencli perplexity ask --help
```

### 2. Install the OpenCode plugin

**Option A — Local file (recommended for development)**

Copy `src/index.ts` to your project or global plugin directory:

```bash
# Per-project
cp src/index.ts .opencode/plugins/perplexity.ts

# Global
cp src/index.ts ~/.config/opencode/plugins/perplexity.ts
```

Add dependencies to your project's `package.json`:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.18.25",
    "@opencode-ai/sdk": "1.18.25",
    "zod": "4.1.8"
  }
}
```

**Option B — Built package**

```bash
bun run build          # → dist/index.js
```

Register in `.opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "plugin": ["file:///absolute/path/to/opencode-plugin-perplexity/dist/index.js"]
}
```

---

## Usage

The plugin exposes one tool: `perplexity_research`.

### Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `question` | `string` | **required** | Query text (min 10, max 4000 chars) |
| `allowedDomains` | `string[]` | — | Domains to mark as `trusted` (suffix match, case-insensitive) |
| `maxWaitSeconds` | `number` | `130` | CLI timeout budget (15–240). Plugin adds +10s hard timeout. |
| `requireSources` | `boolean` | `false` | `true` → empty `sources` returns an error result |
| `mode` | `"search" \| "deep_research"` | `"search"` | Perplexity composer mode |
| `incognito` | `boolean` | `true` | Use Perplexity's incognito toggle (if available on account) |

### Example from chat

```
User: perplexity_research: "Какие ГОСТы регулируют автоблокировку на ЖД?"
```

### Example `opencode.json` snippet

```json
{
  "plugin": ["file:///abs/path/to/opencode-plugin-perplexity/dist/index.js"],
  "options": {
    "logPath": ".opencode/logs/perplexity-research.jsonl"
  }
}
```

---

## Output format

On success, the tool returns a structured `ToolResult`:

```json
{
  "question": "Cookie recipe, in brief",
  "mode": "search",
  "answer_markdown": "Here’s a quick classic chocolate-chip cookie recipe: mix, scoop, ... refrigerate the dough for 20–30 minutes before baking.",
  "sources": [
    {
      "title": "<Site name>",
      "url": "<URL>",
      "accessed_at": "<date>"
    }
  ],
  "thread_url": "<Chat link (if incognito - 404)>",
  "elapsed_seconds": 14.2
}
```

On error, the tool returns a plain string prefixed with `perplexity_research:error:`.

---

## Diagnostics & Troubleshooting

| Command | Purpose |
|---------|---------|
| `opencli doctor` | Full health check: daemon + Browser Bridge + profiles |
| `opencli daemon restart` | Restart daemon if extension shows disconnected |
| `opencli profile list` | List authorized Chrome profiles |
| `opencli profile rename <id> research` | Tag the profile used for Perplexity |
| `opencli perplexity auth` | Check if current profile is logged into Perplexity |
| `opencli perplexity status` | Show active tab URL + login state |

### Common error codes

| Code | Meaning | Fix |
|------|---------|-----|
| `BROWSER_CONNECT` | Daemon not running / extension not connected / wrong profile | `opencli daemon restart`, check extension popup, verify profile ID |
| `AUTH_REQUIRED` / `LOGIN_WALL` | Perplexity session expired or not logged in | Log into `perplexity.ai` in the tagged Chrome profile |
| `SESSION_BUSY` | Another process is driving the Perplexity tab | Wait or kill the conflicting process |
| `TIMEOUT` | Generation didn't finish in `maxWaitSeconds` | Increase `maxWaitSeconds`, restart browser cleanly |

---

## Testing

```bash
bun test
```

Tests cover:
- Successful CLI response parsing (including opencli row-array envelope unwrapping)
- `requireSources=true` with empty sources → error
- Non-zero exit codes with JSON/YAML error payloads → friendly messages
- `allowedDomains` trusted-flag annotation
- `requireSources=false` allows empty sources
- JSONL trace file written on success
- Malformed CLI output → error

---

## Security model

- **No arbitrary commands/URLs** — tool accepts only `question`, `allowedDomains`, and numeric flags
- **No credentials** — auth lives entirely in your Chrome profile managed by OpenCLI
- **Navigation locked to `perplexity.ai`** — enforced by the adapter
- **All output tagged** — every response carries the **НЕДОВЕРЕННЫЕ ДАННЫЕ** disclaimer
- **Verify before use** — Perplexity is a search engine, not a primary source. Cross-check facts against authoritative references (ГОСТ, ПТР, official docs) before using in engineering or normative contexts.

---

## Project structure

```
opencode-plugin-perplexity/
├── src/index.ts              # Plugin entry point (single file, ~430 LOC)
├── test/plugin.test.ts       # Unit tests (bun:test, mocked $)
├── adapter/perplexity/       # OpenCLI site adapter (copied to ~/.opencli/clis/perplexity/)
│   ├── index.js              # Aggregates: ask, auth, new, status, inspect
│   ├── ask.js                # Core flow: CDP type → submit → wait → extract
│   ├── utils.js              # DOM selectors with fallbacks
│   ├── auth.js               # Login wall detection
│   ├── status.js             # Tab URL + login state
│   └── new.js / inspect.js   # Helpers
├── scripts/install-adapter.ts# Copies adapter to ~/.opencli/clis/perplexity/
├── package.json
├── tsconfig.json
└── PLAN.md                   # Design notes & API facts
```

---

## License

MIT