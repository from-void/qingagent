<div align="center">

<img src=".github/assets/logo.svg" alt="qingagent" width="128">

# qingagent 青简

**Writing AI that keeps you in charge**

A more human-friendly way to write documents with AI, with a toolkit built around real writing workflows — for when drafting is hard, reviewing is harder, and typesetting is worst of all.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/from-void/qingagent)](https://github.com/from-void/qingagent/releases)
[![CI](https://github.com/from-void/qingagent/actions/workflows/ci.yml/badge.svg)](https://github.com/from-void/qingagent/actions/workflows/ci.yml)

[qingagent.com](https://qingagent.com) · [Download](https://qingagent.com/#download) · [Changelog](https://qingagent.com/changelog) · [中文](./README.md)

</div>

---

## What is this

qingagent is an **AI writing client that runs on your own computer**.

You tell it what you want in plain language, and it writes the draft into a real editor — not a message in a chat log, but a document you can typeset, edit and export. From then on, every AI edit is laid over your original text as a candidate: you accept or reject them one by one, and **nothing lands until you say so**.

Export to PDF, Word or Markdown when you're done — what you see is what you deliver. Your documents stay on your machine and never pass through our servers.

**It solves three problems:**

| The pain | What qingagent does |
|---|---|
| **Drafting is hard** | Say what you need in one sentence; the AI clarifies before writing, drafts on four parallel lanes and picks the best — a shaped first draft in under a minute |
| **Reviewing is hard** | Every AI change is a candidate you review one by one; 12 role personas (interviewer, client, legal, chief editor…) can nitpick your draft first |
| **Typesetting is hard** | Tables, formulas, diagrams and illustrations sit right on the page; what you write is what exports |

---

## 1. Product tour

### 1.1 One sentence in, a finished draft on the page

Say what you want in the chat box. qingagent narrows things down with a few questions first (say "just draft it" to skip), then streams the draft into the paper-styled editor on the right.

![From one sentence to a finished draft](.github/assets/qa-draft.gif)

| | |
|---|---|
| <img src=".github/assets/shots/questionnaire.webp" alt="Opening questionnaire"> | <img src=".github/assets/shots/draft-done.webp" alt="Finished draft"> |
| **Align before writing** — topic, angle and tone confirmed up front | **The draft lands in the editor** — a document, not a chat message |
| <img src=".github/assets/shots/new-doc-templates.webp" alt="Templates"> | <img src=".github/assets/shots/chat-skills.webp" alt="Skill chips"> |
| **Start from a template** — PRD, competitive analysis, user research and more | **Skills on tap** — web search, illustration, data crunching, one tap away |

### 1.2 Review before apply: the AI edits, you decide

When you ask for changes, the AI never overwrites your text. Every edit appears as a candidate on the original; you walk through them, accept or reject, and only then does a new version land — rejected changes never enter your document, and versions roll back.

![Reviewing candidate diffs end to end](.github/assets/qa-review.gif)

| | |
|---|---|
| <img src=".github/assets/shots/patch-review.webp" alt="Candidate diffs"> | <img src=".github/assets/shots/patch-committed.webp" alt="Committed"> |
| **Review one by one** — previous / next navigation, partial undo supported | **Commit to land** — confirmed changes become a new version |

### 1.3 Review center: an editorial team on call

Have different reviewers read your draft before you ship it. qingagent ships with 8 review types and 23 templates (11 general + 12 role perspectives):

| | |
|---|---|
| <img src=".github/assets/shots/review-menu.webp" alt="Review menu"> | <img src=".github/assets/shots/role-review.webp" alt="Role review"> |
| **8 review types** — sensitive words, de-AI-flavor, source check, consistency, privacy, format, role-based, custom | **12 role perspectives** — HR recruiter, interviewer, demanding client, legal & compliance, chief editor, investor… |
| <img src=".github/assets/shots/review-annotations.webp" alt="Annotations"> | <img src=".github/assets/shots/review-notes.webp" alt="Annotation list"> |
| **Annotation mode** — comments only, text untouched; hover for the quote, reason and suggestion | **Dismissed once, gone for good** — suggestions you rejected are remembered |

Two ways to work: launching a review from the menu **only creates annotations and never touches the text**; asking for "fix it and review" in chat lets the AI edit first — those edits still queue up as candidates for your approval.

### 1.4 After the draft: one piece, many forms

| | |
|---|---|
| <img src=".github/assets/shots/new-draft-types.webp" alt="Derivatives"> | <img src=".github/assets/shots/xhs-style-modal.webp" alt="Xiaohongshu styles"> |
| **Derivatives** — Xiaohongshu posts, WeChat official-account layouts, translations (20 languages, up to 5 per run) | **Covers generated for you** — 5 Xiaohongshu cover templates, export-ready |
| <img src=".github/assets/shots/xhs-preview.webp" alt="Device preview"> | <img src=".github/assets/shots/export-menu.webp" alt="Export"> |
| **Preview before publishing** — see the real layout first | **Five export formats** — PDF / Word / Markdown / HTML / TXT |

### 1.5 Materials, skills and models

| | |
|---|---|
| <img src=".github/assets/shots/materials.webp" alt="Materials"> | <img src=".github/assets/shots/websearch-sources.webp" alt="Web search"> |
| **Materials panel** — PDF / Word / Excel / PPT / TXT / Markdown / CSV parsed locally | **Web search and page fetching** — sources you can check, not invented citations |
| <img src=".github/assets/shots/skills-builtin.webp" alt="Built-in skills"> | <img src=".github/assets/shots/skills-thirdparty.webp" alt="Import skills"> |
| **13 built-in skills** — browser automation, web search, reading materials, diagrams, Feishu, GitHub, WeChat scraping… | **Import your own** — drop in a `SKILL.md` or ZIP; Anthropic-style skills come along for the ride |
| <img src=".github/assets/shots/model-panel.webp" alt="Model settings"> | <img src=".github/assets/shots/usage-details.webp" alt="Usage dashboard"> |
| **Bring your own key** — DeepSeek or Kimi, flash / pro tiers | **Usage dashboard** — tokens, cache hits, call counts and spend, all local |

### 1.6 Open source, free, running on your own machine

qingagent is MIT-licensed and costs nothing beyond your own model API usage. A ~3,000-character article runs about **¥0.05–0.10** in model fees (estimated from DeepSeek V4 Flash peak/off-peak pricing). All data stays on your machine and never passes through our servers.

---

## 2. Download & install

**The preferred route is the client from [qingagent.com](https://qingagent.com/#download)** — one-click install on Windows and macOS; packages are also on [GitHub Releases](https://github.com/from-void/qingagent/releases).

| Platform | Package | Notes |
|---|---|---|
| Windows | `.exe` (NSIS) / `.zip` portable | Windows 10+ · x64 |
| macOS | `.dmg` (drag to Applications) / `.zip` | Apple Silicon and Intel, signed and notarized |
| Linux | `.AppImage` / `.deb` | Community-supported |

Launch it once and enter your own DeepSeek or Kimi API key in settings to start writing. (Packaged desktop builds ignore model environment variables — the key comes from the in-app settings.)

---

## 3. Desktop-first, with a web build for local agent debugging

qingagent is **first and foremost a desktop client**: local database, filesystem access, a bundled `qa` command line and OS-level deep links all assume the desktop form.

The same codebase can also be **built and run as a web app locally** — useful for walkthroughs, acceptance checks, and **debugging agent behaviour on your own machine** (tweaking prompts, watching tool calls, validating skills).

### Running from source

Prerequisites: Node ≥ 22, pnpm 9.15.0, and a [DeepSeek API key](https://platform.deepseek.com).

```bash
# one-time setup
corepack enable && corepack prepare pnpm@9.15.0 --activate

git clone https://github.com/from-void/qingagent.git
cd qingagent
pnpm install

# configure: model key, plus an access token for the web form
cp packages/server/.env.example packages/server/.env
#   DEEPSEEK_API_KEY=<your key>
#   QINGAGENT_AUTH_TOKEN=$(openssl rand -hex 32)

pnpm dev:server   # backend at http://127.0.0.1:8080
pnpm dev          # frontend at http://localhost:6173 (/api proxies to :8080)
```

> `pnpm dev` starts only the frontend — run both commands. 6173 is the default port and shifts automatically when occupied.

Open `http://localhost:6173`, enter the `QINGAGENT_AUTH_TOKEN` you set, and it is exchanged for a same-origin HttpOnly cookie. The token never appears in the URL.

**Web vs desktop** — the web form is deliberately more conservative:

| Capability | Desktop client | Web / self-hosted |
|---|---|---|
| Model key source | In-app settings only | visitor / database / environment variable |
| Unisolated commands, credential injection, Pyodide | Enabled by the main process | Must be enabled explicitly |
| Skill / template mutation | On | Off |
| Connectors (GitHub / Feishu / WeChat) | Available | Off; requires single-user declaration |
| Agent browser | Auto-enabled when Chrome/Edge is detected | Off |
| PDF export | Electron `printToPDF` | Playwright Chromium |

---

## 4. qingagent inside DeepSeek Harness

qingagent now supports the **DeepSeek Harness plugin system** — [**dsh-qingagent**](https://github.com/from-void/dsh-qingagent).

With the plugin installed, you shape the writing in a DSH conversation while the agent drafts, edits and submits reviews through the qingagent engine; a **paper panel built from the same source as the desktop app** grows on the right, with per-change verdicts, annotation carousel, diagram editing and export. Documents live in the **same local library** as the desktop client — write it in DSH, keep editing it in qingagent.

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-qingagent@latest
```

> The plugin talks to the local qingagent engine, so install and launch the desktop client once first. See the [dsh-qingagent repo](https://github.com/from-void/dsh-qingagent).

---

## 5. Under the hood

### Architecture

```
apps/web              Vite + React SPA (:6173, /api proxied to the backend)
apps/desktop          Electron shell: embedded server, deep links, qa CLI, data in userData
packages/server       Hono HTTP/SSE service (:8080), session gateway and routes
packages/core         Mastra agent brain: tools, skills, models, memory, workspace
packages/db           libSQL data access, migrations, repositories
packages/doc-render   Document rendering and export (HTML/PDF/DOCX), browser infrastructure
packages/pm-schema    TipTap / ProseMirror schema, extensions, AI-IR conversion
packages/diagram-engine  Diagram model and conversion engine
packages/contract-ts  Hand-written frontend/backend contracts
packages/ui-kit       Single source of truth for design tokens and base styles
packages/qa-cli       The qa command line used by external agents
```

**Data flow in one line**: user message → Hono SSE → Mastra agent (DeepSeek / Kimi) → clarifying questionnaire → four parallel drafting lanes, best one wins → candidate diff (user confirms → optimistic-concurrency version commit) → TipTap/ProseMirror rendering. Generation is server-driven and **survives disconnects**: close the tab, come back, the draft is still being written.

### Prompt prefix caching

The biggest cost in long sessions is re-sending context. qingagent stabilises the prompt prefix end to end:

- system runtime instructions and environment descriptions are memoized per process, byte-identical across turns;
- the session briefing is written once at session creation and becomes an immutable prefix;
- active-document context is appended only to the **latest** user message, never rewriting history;
- tool definitions are normalised and sorted before entering the snapshot, with controlled additions from tool search.

`QINGAGENT_PREFIX_CACHE_GUARD` offers three levels: `off`, `warn` (log prefix drift) and `strict` (throw); CI defaults to strict. Combined with DeepSeek's prefix-cache pricing, this is why an article costs a few cents.

### Skills

The built-in capability tree contains **13 top-level skills and 15 sub-skills (28 SKILL.md files)**: browser automation, CLI authorisation, derivative writing (translation / WeChat / Xiaohongshu), diagram visualisation (Mermaid / draw.io), data crunching, Feishu, GitHub reading, illustration (SVG / local Codex images), image reading, materials, document review (8 sub-types), web search, and WeChat official-account scraping.

You can install your own skills by uploading a single `SKILL.md` or a ZIP into `~/.qingagent/skills`. The parser reads YAML frontmatter (`name` / `description` / `label`) and also scans `~/.claude`, `~/.codex` and `~/.agents` — **skills you already have in the Claude Code or Codex ecosystem are discovered and reused directly**.

### Observational memory

Each session runs an observational-memory sidecar that continuously distils the conversation using the flash-tier model. Past 500k tokens of context it switches to a compressed projection — "observations + the last 12 turns" instead of full history — so details agreed dozens of turns ago still hold. On by default; note it makes extra observation-model calls that cost money.

### Review center internals

8 review types (`sensitive`, `deai`, `source`, `consistency`, `privacy`, `format`, `role`, `custom`) with 23 factory templates. Sensitive-word review is a deterministic dictionary scan: hits become annotations and replacements are context-aware candidates, never blind substitutions. Dismissals are stored under PII-masked stable keys and can be distilled into document-level review supplements.

### External agent access

The desktop package bundles the `qa` command line (`Resources/qa-cli/cli.mjs`; a shim is written to `~/.qingagent/bin/qa` on first launch). Through `/api/v1/external/*`, external agents such as Claude Code and Codex can read documents and sessions, send chat messages, upload and read attachments, submit edit proposals, subscribe to events, and manage review templates and skills.

Proposal operations: `fullDraft`, `qingml`, `setTitle`, `strReplace`, `markText`, `insertAfterLine`, `insertAfterBlock`, `appendSection`, `deleteBlock`, `deleteListItem`. **External edits go through the same review flow** — nothing is silently written into your text.

### Single-library attach mode

On launch the desktop app writes instance details to `~/.qingagent/instance.json` (`schemaVersion`, `port`, `pid`, `version`, `attachProtocolVersion`, `instanceId`, `libraryId`, a 256-bit `token`, `startedAt`). The port defaults to `21823` and falls back to an OS-assigned random port when taken — **the port in the instance file is authoritative**.

A second desktop process that finds a live instance with the same `libraryId` attaches to it instead of starting its own server. Expired tokens or sessions re-authenticate automatically; if the original instance disappears, rediscovery retries with 1–8 s exponential backoff and completes within roughly 30 s. This is the same protocol the DSH plugin uses to reach qingagent.

### Export pipeline

The ProseMirror document is processed for diagrams and rich content into HTML, then split by target: web/server renders PDF through Playwright Chromium at A4, desktop through Electron `printToPDF`; DOCX, TXT, Markdown and HTML each have their own conversion.

---

## 6. Configuration

Desktop single-user usage needs no configuration. **Web / self-hosted deployments must set `QINGAGENT_AUTH_TOKEN`.**

**Basics**

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | unset | Model key. Precedence: in-app config > database > environment. **Packaged desktop builds ignore the environment variable** |
| `PORT` | `8080` (server) | Backend port; use `QINGAGENT_WEB_PORT` for the web app |
| `QINGAGENT_WEB_PORT` | `6173` | Vite dev/preview port; takes precedence over `PORT`, shifts when occupied |
| `QINGAGENT_DEEPSEEK_BASE_URL` | official endpoint | Custom model gateway |
| `QINGAGENT_MODEL_FLASH` / `_PRO` | DeepSeek `deepseek-v4-flash` / `deepseek-v4-pro`; Kimi `kimi-for-coding` / `k3` | Fast / strong tier model ids |
| `QINGAGENT_MODEL_PROTOCOL` | `openai` | `openai` or `anthropic`; Kimi is always OpenAI-compatible |
| `QINGAGENT_ALLOW_PRIVATE_MODEL_HOST` | server off; desktop `1` | Allow the main model to reach private / link-local hosts; loopback always allowed |

**Feature switches**

| Variable | Default | Notes |
|---|---|---|
| `QINGAGENT_AGENT_BROWSER` | server off; desktop auto-`1` when Chrome/Edge is detected | Agent browsing and scraping |
| `QINGAGENT_OM_SIDECAR` | on | Observational memory; unless disabled it makes extra model calls that cost money |
| `QINGAGENT_OM_COMPRESS` | on | Long-context compression (threshold `QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS`, default 500000) |
| `QINGAGENT_TOOL_SEARCH` | off | On-demand retrieval for rarely used tools |
| `QINGAGENT_PYODIDE_ENABLED` | probes assets when unset and enables if available; desktop `1` | Python sandbox for the data-crunching skill |
| `QINGAGENT_PROCESSOR_PROMPT_INJECTION` / `_MODERATION` / `_PII` | off | LLM input guardrails |
| `QINGAGENT_PREFIX_CACHE_GUARD` | `off`; `strict` under CI | Prefix cache guard: off / warn / strict |
| `QINGAGENT_AGENT_MAX_STEPS` / `_IDLE_TIMEOUT_MS` | `200` / `90000` | Per-turn step ceiling / idle timeout |
| `QINGAGENT_USER_VERSION_WINDOW_MS` | `60000` | User-edit version coalescing window (0 disables) |
| `QINGAGENT_SKILLS_DIR` / `_USER_SKILLS_DIR` / `QINGAGENT_LOG_DIR` | bundled dir / `~/.qingagent/skills` / `.logs` | Path overrides; desktop points at `resources/skills` and `userData` |

**Security & deployment**

| Variable | server | desktop | Purpose |
|---|---|---|---|
| `QINGAGENT_AUTH_TOKEN` | unset | not user-facing | Required for command mutations in the web form; the server refuses to start on a non-loopback bind without it. Desktop uses a per-process global command token — a different key from the `instance.json` token used by external/attach |
| `QINGAGENT_HOST` | `127.0.0.1` | loopback, fixed | Backend bind address |
| `QINGAGENT_TRUSTED_ORIGINS` | empty (local dev origins built in) | same | Extra trusted full origins (scheme included), comma-separated |
| `QINGAGENT_PUBLIC_ORIGIN` | unset | unset | Canonical origin for `/api/` links inside exports |
| `QINGAGENT_TRUST_PROXY` | unset | unset | Only `=1` trusts `X-Forwarded-Host/Proto` |
| `QINGAGENT_ALLOW_UNAUTHENTICATED_PUBLIC` | unset | unset | Dangerous escape hatch: `=1` permits token-less non-loopback binds |
| `QINGAGENT_PUBLIC_DEPLOYMENT` | unset | unset | Declares a publicly reachable deployment for debug/dataAdmin gating |
| `QINGAGENT_BROWSER_PROXY_ACL` | unset | unset | Must be `deny-private` when HTTP(S)_PROXY is set, otherwise proxied browsing fails closed |
| `QINGAGENT_ENABLE_DEBUG` | unset | unset | debug / dataAdmin routes return 404 by default |
| `QINGAGENT_ALLOW_NO_SANDBOX` | unset | unset | Dangerous escape hatch: `=1` adds `--no-sandbox` to Chromium; sandbox is enforced by default |
| `QINGAGENT_TELEMETRY_DISABLED` | unset | unset | `=1` disables anonymous stats in official desktop builds |
| `QINGAGENT_UPLOAD_MAX_BYTES` | `52428800` (50 MB) | same | Per-file upload ceiling |
| `DATABASE_URL` | `~/.qingagent/qingagent.db` | `userData/qingagent.db` | libSQL database location |

**Dangerous capabilities — read before enabling**

| Variable | server | desktop | Notes |
|---|---|---|---|
| `QINGAGENT_ALLOW_UNISOLATED_COMMANDS` | variable unset, but the global security profile currently defaults to "don't ask again" and **does allow** unisolated commands | main process sets `1` | Lets the agent run commands on your machine; enabling it publicly widens the RCE surface |
| `QINGAGENT_SANDBOX_INJECT_CREDENTIALS` | variable off (`1/true/yes/on` enables), though the default profile already assembles a full user environment | main process sets `1` | Injects credentials into the execution environment |
| `QINGAGENT_ALLOW_SKILL_MUTATION` | off | **unconditionally set to `1`; an explicit `0` does not disable it** | Installing / removing skills |
| `QINGAGENT_ALLOW_TEMPLATE_MUTATION` | off | **unconditionally set to `1`; an explicit `0` does not disable it** | External API mutation of review templates |

---

## 7. Security

> **⚠️ Deployment warning: qingagent is designed for a single user and a single tenant. There is no data or permission isolation between users. `QINGAGENT_AUTH_TOKEN` is an all-or-nothing shared secret, not an identity; anyone holding it and able to reach the backend can read, modify and delete every session and document, and burn through your model quota. Do not deploy it as a multi-tenant service on the public internet.**

- **The default boundary is local loopback.** The backend binds `127.0.0.1` by default, and that is exactly what the desktop app does. Exposing it further is an explicit choice with explicit responsibility.
- **Command channel.** `POST /api/v1/commands` always requires deterministic credentials and a trusted browser origin. On desktop the main process proxies in a global command token that the renderer never sees; the token in `instance.json` serves `/api/v1/external/*` and attach only.
- **`?auth=<token>` is a local debugging escape hatch.** Logs redact it, but the full URL can still land in browser history and reverse-proxy logs — use `Authorization: Bearer` for anything exposed.
- **Deployment shape.** Session runtime state lives in a single process and SSE connections bind to it; there is no horizontal scaling. Documents and version history persist in the local database.
- **Chromium boundary.** Scraping, PDF export and the autonomous browser enable the Chromium sandbox and site isolation by default. `QINGAGENT_ALLOW_NO_SANDBOX=1` exists as an escape hatch and adds `--no-sandbox` — use it only if you fully understand the consequences. When browsing through a proxy, the proxy must reject private, loopback, link-local and cloud-metadata targets at connection level, confirmed via `QINGAGENT_BROWSER_PROXY_ACL=deny-private`; without that confirmation proxied fetching fails closed.
- **Startup refusal.** The server refuses to start only when the actual bind address is non-loopback *and* `QINGAGENT_AUTH_TOKEN` is unset. A token-less non-loopback bind requires the explicit `QINGAGENT_ALLOW_UNAUTHENTICATED_PUBLIC=1`, which prints an audit warning.

Public reverse proxy (only for one trusted user reaching their own instance): nginx/caddy + HTTPS + a strong random `QINGAGENT_AUTH_TOKEN` + precise `QINGAGENT_TRUSTED_ORIGINS` (full origins including scheme).

**Data and backups.** The database is the libSQL file at `DATABASE_URL` (`~/.qingagent/qingagent.db` by default, `userData` on desktop). Copy the `-wal` / `-shm` files alongside it, or stop the service first. Sandbox credentials are stored encrypted in the same database.

Report vulnerabilities via [SECURITY.md](./SECURITY.md) — please do not disclose unfixed issues in public issues.

---

## 8. Privacy & telemetry

- **Source / local builds**: no telemetry endpoint is configured, and **nothing is sent**.
- **Official desktop releases**: anonymous usage stats (launches, feature clicks, redacted errors, self-hosted Umami). **Document content, chat input, attachments and API keys are never collected.** Set `QINGAGENT_TELEMETRY_DISABLED=1` to turn it off entirely.
- Full event schema in [PRIVACY.md](./PRIVACY.md).

---

## 9. Contributing

Issues and PRs are welcome. A few practical rules:

1. **Open an issue before large changes** — architecture, new dependencies, interaction redesigns. Align first, code second.
2. **PRs must pass `pnpm check`** (typecheck + tests + build). Red CI does not get merged.
3. **Write commit messages in English or Chinese**, but make the motivation clear: what changed, why, and what it affects.
4. **New runtime dependencies need justification** — this project cares about bundle size and supply chain; small utilities should be written, not installed.
5. **PRs touching security defaults, authentication, the Chromium sandbox or the external API** should include a short security-impact analysis.
6. **Documentation changes must update both READMEs** (`README.md` and `README.en.md`) so the facts stay in sync.
7. **Never open a public issue for a vulnerability** — email security@qingagent.com instead. See [SECURITY.md](./SECURITY.md).

Development conventions live in [CONTRIBUTING.md](./CONTRIBUTING.md); community expectations in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

---

## 10. Community

Scan to join the WeChat user group — report problems, request features, follow updates:

<!-- TODO: WeChat group QR code pending -->
<!-- <img src=".github/assets/wechat-group.png" alt="qingagent user group" width="220"> -->

You can also request and upvote features on the [feature board](https://qingagent.com/feedback).

---

## 11. Contact

- Usage questions, bugs, feature requests: [GitHub Issues](https://github.com/from-void/qingagent/issues)
- Security: security@qingagent.com

<!-- TODO: author contact pending -->

---

## License

[MIT](./LICENSE). Bundled third-party components are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
