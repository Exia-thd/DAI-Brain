# Getting started — step by step

**English** · [Tiếng Việt](QUICKSTART.vi.md)

This takes you from nothing to a chat window with memory. Every step says what
you should see, so you know it worked before moving on.

There are two routes. Read the table, pick one, don't do both.

| | Route A — personal | Route B — full |
|---|---|---|
| For | one person, one machine | several people, or you want every feature |
| Needs | Node 22+, the Claude CLI | plus Docker (or Postgres) |
| Memory | the DAI Memory plugin | Brain Core (hybrid retrieval) |
| Citations, pre-fetch, learning from chats | no | yes |
| Time | ~5 minutes | ~15 minutes |

> **If the terminal is enough for you, you do not need this guide.** Installing
> the plugin (step 2 below) gives you memory inside Claude Code with no
> Gateway, no UI and no database. The rest is only worth it if you specifically
> want the chat window.

---

## Route A — personal chat, no database

### Step 0. Check the machine

```bash
node --version      # must be >= v22
claude --version
```

**Expect:** Node `v22.x` or later, and the Claude CLI printing a version.

<details>
<summary>If Node is older than 22</summary>

Route A uses `node:sqlite`, which arrived in Node 22. Upgrade Node, or take
Route B — Postgres works on Node 20.
</details>

<details>
<summary>If <code>claude</code> is missing</summary>

```bash
npm install -g @anthropic-ai/claude-code
```
</details>

### Step 1. Sign the CLI in, then set two variables

```bash
claude            # sign in once if you have not, then quit
export CLAUDE_MODEL=claude-sonnet-5      # Windows: set CLAUDE_MODEL=...
```

If you have your own API key, use it instead of the login:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

**Why this comes first:** every message spawns a whole Claude CLI session.
Without an API key it uses your existing login and bills your subscription — a
bug in the Gateway could lock you out of the Claude Code you were using to fix
it. Without `CLAUDE_MODEL` every turn runs on the CLI's default, the expensive
one.

Can you skip it? Yes, the Gateway runs and warns. But this is what consumed the
author's whole quota while building this.

### Step 2. Install the memory plugin

In Claude Code:

```
/plugin marketplace add Exia-thd/DAI-memory-layer-plugin
/plugin install dai-memory
```

Then run its one-time setup (see the plugin's README — it installs dependencies
and downloads the embedding model).

**Check:**

```bash
dai-memory --help
```

**Expect:** a list of commands. `command not found` means the setup has not
finished.

### Step 3. Get DAI Brain and build it

```bash
git clone -b main https://github.com/Exia-thd/DAI-Brain
cd DAI-Brain
pnpm install
pnpm build
```

**Expect:** `pnpm build` prints nothing. Silence is success.

<details>
<summary>If pnpm is missing</summary>

```bash
npm install -g pnpm
```
</details>

### Step 4. Run it

```bash
pnpm chat --dir /path/to/your/project --project inventory
```

That one command does the rest: it finds the plugin, writes `plugin-mcp.json`
pointing at it, runs `dai-memory init` if the project has no store yet, and
starts the window.

**Plugin not installed?** It **asks**, right there in the terminal, and does
it if you press Enter: clones the plugin beside this repo, runs `pnpm install`
and `pnpm build`, then downloads the embedding model. `--install-plugin` skips
the question.

```bash
pnpm chat --install-plugin --dir /path/to/your/project --project inventory
```

It looks in the Claude Code plugins directory (all four per-platform
locations), **the parent of this repo** — where checkouts usually sit —
`~/Projects` and `~/source/repos`. When it finds nothing it prints the exact
paths it tried and three ways to fix it. `--plugin <path>` points straight at a
checkout; `--no-init` skips creating the store.

Replace `inventory` with your own name — it is only a label that keeps one
project's memory apart from another's.

**Expect:** a block like this.

```
[chat] wrote /.../plugin-mcp.json — edit it if your memory server differs
[chat] http://localhost:8080

[gateway] dai-brain-gateway 0.1.0 on :8080
[gateway]   store:       sqlite — /home/you/.dai-brain/conversations.db
[gateway]   core:        none (memory comes from the runner's MCP servers)
[gateway]   mcp:         none
[gateway]   runner:      claude (max 1 concurrent)
[gateway]   write-back:  off
[gateway]   extra tools: mcp__dai-memory__dai_memory_search, ...
[gateway]   model:       claude-sonnet-5
[gateway]   cost ceiling: $5.00 per conversation
[gateway]   claude auth: your own `claude` login (no API key set)
[gateway]   AUTH DISABLED — every request runs as me/me/inventory
```

Three lines worth reading:

- `claude auth:` — "your own `claude` login" means it uses your CLI login. If
  you have never run `claude` and signed in, the first turn fails with
  `Invalid API key · Please run /login`.
- `model:` — if it says `(CLI default)` you skipped step 1, and every turn is
  running on the most expensive model.
- `AUTH DISABLED` — it means it. **Do not expose port 8080 to the internet**:
  anyone who reaches it spends your quota.

### Step 5. Open it and ask

Open <http://localhost:8080>.

Try these in order:

1. `Hello` → text streams in.
2. `Remember this: this project uses PostgreSQL rather than MongoDB, because we
   need transactions.` → a **saving to memory** chip appears.
3. Click **+ New**, then ask `What database does this project use, and why?`
   → a **searching memory** chip appears, and the answer gives the reason back.

Step 3 is the real test: a fresh conversation with no context, answered from
memory.

**Bottom left** shows the running cost, e.g. `$0.0431 / $5.00 · 2 turns`, and
turns amber past 80% of the ceiling.

---

## Route B — the full setup, with Brain Core

### Step 0. Check the machine

```bash
node --version      # >= v20 is enough for this route
docker --version
```

### Step 1. Start the infrastructure

```bash
cd DAI-Brain/infra
cp .env.example .env
```

Open `.env` and set at least:

```bash
GATEWAY_DEV_SCOPE=me/me/inventory
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-5
```

Then:

```bash
docker compose up -d
```

**Check:**

```bash
curl http://localhost:8081/health
```

**Expect:** JSON containing `"ok":true`, with `vectorIndex` reading
`available`.

<details>
<summary>If <code>vectorIndex</code> reads <code>degraded</code></summary>

That is fine. Without pgvector it runs an exact scan: slower, and **correct**.
Measured on the eval set, recall@10 is 89.6% against 90.7%. You need Postgres,
not pgvector.

If it reads **IVFFlat**, run `pnpm migrate` — that is the old index, and it
returns only part of the store without reporting an error.
</details>

### Step 2. Seed memory from your repository

```bash
cd ..
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain
pnpm ingest:repo /path/to/your/project --scope me/me/inventory --dry-run
```

**Expect:** a list of what *would* be stored, with a summary like
`found 52 candidate memories: preference=6 artifact=17 decision=28 note=1`.

**If it finds little or nothing:** that is the tool working, not failing. It
reads *reasoning* — ADRs, `CONTRIBUTING`, `CLAUDE.md`, README sections that
argue for a choice, commit messages with a body. A repository that never wrote
any reasoning down has none to give. It does **not** index code.

Happy with it? Drop `--dry-run`:

```bash
pnpm ingest:repo /path/to/your/project --scope me/me/inventory
```

### Step 3. Open the UI

<http://localhost:8080> — as in Route A, but now with a **Memory** tab.

In the Memory tab, type a question and press Enter. You will see the **fusion
report**:

```
branches: vector=9  fts=1  graph=0  ·  9 matched, 0 omitted  ·  453/4000 tokens  ·  16ms
⚠ graph: no entity in this scope matched the query text
```

This is the most useful debugging tool here. When retrieval is bad, that line
tells you which branch contributed nothing, and **why**.

---

## When it breaks

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid API key · Please run /login` | the CLI is not signed in, or the Gateway isolated its config directory | run `claude` and sign in once; if you do have `ANTHROPIC_API_KEY` and still see it, set `GATEWAY_ISOLATE_CLAUDE_CONFIG=false` |
| `ERR_PNPM_IGNORED_BUILDS` installing the plugin | pnpm 10 blocks build scripts, and the plugin declares its exceptions where pnpm 10 no longer reads them | `pnpm chat --install-plugin` handles it; or add `onlyBuiltDependencies` to the plugin's `pnpm-workspace.yaml` |
| `lbugjs.node: cannot open shared object file` | the blocked build script never copied the native binary | as above |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` | Node older than 22 | upgrade Node, or set `DATABASE_URL` to use Postgres |
| `could not start claude` / `ENOENT` on Windows | Node cannot spawn a `.cmd` | `npm root -g`, then `set CLAUDE_BIN=%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js` |
| `port 8080 is already in use` | an earlier run is still alive | close that terminal, or `pnpm chat --port 8090` |
| No memory tools at all | the plugin setup has not finished | run `dai-memory --help`; the MCP command is `serve`, not `mcp` |
| `No memory store found at or above ...` | the turn ran somewhere without a store | pass `--dir` pointing at the project you ran `dai-memory init` in |
| `This conversation has spent $5.00...` | the cost ceiling | click **+ New**, or `pnpm chat --budget 20` |
| The model says it does not trust a memory result | an MCP server is declared but not running | remove it from the config; a declared-but-dead server is worse than none |
| `vectorIndex: degraded — legacy IVFFlat` | the old index | `pnpm migrate` |
| Blank UI | not built | `pnpm build`, then restart |

## Where to go next

- Add Jira or another MCP server to the UI → *Giving the UI other tools* in [README.md](README.md)
- Use memory in the Claude Code terminal → *Use DAI Brain from your own Claude Code*
- Understand how retrieval works → *Retrieval*
- Costs and what stops them → *What it costs, and what stops it*
