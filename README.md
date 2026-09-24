# DAI Brain

**English** · [Tiếng Việt](README.vi.md)

**New here? Start with the [step-by-step guide](QUICKSTART.md).** This file is
the reference; that one is the walkthrough.

A memory system with four parts. **Core** is the memory service — retrieval,
ingestion, storage. **MCP** exposes Core to Claude as four tools. **Gateway**
orchestrates the UI, the Claude CLI and Core. **UI** is the chat client.

All retrieval logic lives in Core. MCP and Gateway are thin adapters, which is
what makes the Claude CLI replaceable by the Agent SDK, or this UI replaceable
by another, without touching the part that decides what a memory system
returns.

```
dai-brain/
├── core/      memory service: retrieval, ingestion, storage (Postgres + pgvector)
├── mcp/       MCP server adapter — four tools over streamable HTTP
├── gateway/   orchestrator: spawns claude -p, SSE, sessions, write-back
├── ui/        web UI — chat and memory explorer, no build step
├── shared/    contracts: DTOs, event schema, scope model
├── eval/      golden query set + retrieval metrics
└── infra/     docker-compose, Dockerfile, env template
```

## Quick start

```bash
cp infra/.env.example infra/.env     # edit it
cd infra && docker compose up
```

Then open <http://localhost:8080>.

Running it directly instead:

```bash
pnpm install
pnpm build

export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain
pnpm migrate

pnpm core                                              # :8081
CORE_URL=http://localhost:8081 pnpm mcp                # :8082
GATEWAY_DEV_SCOPE=acme/me/daibrain pnpm gateway        # :8080
```

`GATEWAY_DEV_SCOPE` disables authentication and runs every request as one
user. It is refused when `NODE_ENV=production`.

## The personal setup: chat window, no servers

One person, one machine, memory from the plugin. No Postgres, no Brain Core, no
Brain MCP — just the Gateway and the chat UI.

### Set it up

The Claude CLI has to exist and be signed in before any of this: the Gateway is
not an LLM client, it spawns `claude -p` for every message. `claude -p "ping"`
answering is the check.

**1. Get the plugin, and finish its setup.** A plugin install copies the
repository. It does not install dependencies, compile it, or download the
embedding model — and the server does not start without all three. Whichever
way you get the files, `bin/setup.mjs` is the step people skip:

```bash
# Either: let the launcher fetch and build it for you (does setup.mjs too)
pnpm chat --install-plugin --dir /path/to/your/project

# Or: install it in Claude Code
#   /plugin marketplace add Exia-thd/DAI-memory-layer-plugin
#   /plugin install dai-memory
# ...then run its setup once. `pnpm chat` prints where it found the plugin on
# its `[chat] memory server:` line; the marketplace layout differs per platform,
# so read that path rather than guessing one:
node <that directory>/bin/setup.mjs

# Or: your own checkout
git clone https://github.com/Exia-thd/DAI-memory-layer-plugin
node DAI-memory-layer-plugin/bin/setup.mjs
```

`setup.mjs` needs network access and downloads about 130 MB of embedding model.
Re-running it finishes whatever is left.

**2. Give the project a store.** The plugin finds its store by walking up from
the working directory, so it belongs in the project, not here:

```bash
cd /path/to/your/project && dai-memory init

# No `dai-memory` on PATH (a hand-made checkout does not install one):
cd /path/to/your/project && node /path/to/DAI-memory-layer-plugin/bin/dai-memory.mjs init
```

`pnpm chat` runs this for you when it finds no store.

**3. Run the chat window.** One command; it writes `plugin-mcp.json` if missing:

```bash
pnpm install && pnpm build
pnpm chat --dir /path/to/your/project --project myproject
```

Or spell every variable out yourself:

```bash
cat > plugin-mcp.json <<'JSON'
{ "mcpServers": { "dai-memory": { "command": "dai-memory", "args": ["serve"] } } }
JSON

CORE_URL=none \
GATEWAY_DEV_SCOPE=me/me/myproject \
GATEWAY_MAX_CONCURRENCY=1 \
GATEWAY_EXTRA_MCP_CONFIG=./plugin-mcp.json \
GATEWAY_EXTRA_ALLOWED_TOOLS='mcp__dai-memory__*' \
GATEWAY_PROJECT_DIR=/path/to/your/project \
pnpm gateway
```

The allowed tools are the **whole server**, not a list of its tools. The plugin
exposes twenty; a hand-written list of the five you remember means the other
fifteen are denied at call time, and a denied memory tool does not make the
model give up — it makes it try to read your files instead. `mcp__<server>__*`
is the documented form and cannot go stale.

### Checking that memory actually works

`pnpm chat` starts each stdio server from the MCP config, completes the MCP
handshake and asks it for its tools, before opening anything. The first lines
tell you where you stand:

```
[chat] DAI Brain e5e28e1
[chat] memory server: ~/dai-memory-layer-plugin/bin/dai-memory.mjs
[chat] dai-memory: 20 tools (dai_memory_search, dai_memory_why, dai_memory_get, dai_memory_neighbors, …)
[chat] project:  /path/to/your/project
[chat] http://localhost:8080
```

That third line is the one that matters. When it fails instead, the server's own
message is relayed, and it names the fix:

```
[chat] the dai-memory server did not start: it exited with code 1.
    The embedding model is not downloaded: config.json, tokenizer.json,
    tokenizer_config.json, onnx/model_quantized.onnx missing under
    ~/.memory/models/Xenova/paraphrase-multilingual-MiniLM-L12-v2.
    Run `node bin/setup.mjs` with network access.
[chat] the chat will open, but it will have no memory from dai-memory.
[chat] pass --no-probe to skip this check.
```

A server that dies later, or after the check passed, is caught mid-turn instead:
Claude's own startup line reports each MCP server's status, and a status other
than connected becomes a red message in the chat rather than a quieter answer.

> The dai-memory MCP server did not connect (failed), so this answer is not
> grounded in memory.

That turn is also kept out of write-back. Memory should not learn from a turn
that could not read memory.

| What you see | What it means |
|---|---|
| `dai-memory: 20 tools (…)` | memory is live; ask it something |
| `did not start: it exited with code 1` | read the relayed message — usually `setup.mjs` was never run |
| `did not start: it did not answer within 30s` | the server is hanging; run its command by hand to see why |
| `connected but this session has no memory tools` | the allow list names a server that is not the one running |
| `No such tool available: Bash`, or the model reads files | memory was unreachable and the model went looking elsewhere |

Open <http://localhost:8080>. Conversations go into a SQLite file under the
session root (`node:sqlite`, so no dependency). The Memory tab removes itself,
because there is no Core behind it to browse.

On Windows the same thing, with `set` instead of the inline variables, and
`CLAUDE_BIN` if the CLI cannot be resolved — see *Running on Windows*.

The turn runs **in the project directory you pass with `--dir`**, because a
file-backed memory server finds its store by walking up from there. A
per-conversation scratch directory means it finds nothing and reports the store
as missing.

That also means the model can *read* files in that directory. `--allowedTools`
turned out to be an allow list for tools that would otherwise prompt, not a
fence around everything else — a turn observed here called `Read` without it
being listed. Reading your own project from a chat window about it is
reasonable; writing and executing are not, so `Bash`, `Write`, `Edit`,
`MultiEdit`, `NotebookEdit` and `KillShell` are refused by name.
`GATEWAY_DISALLOWED_TOOLS` changes the list.


### Attaching files

The composer takes files: the **＋** button, drag and drop onto it, or paste.
They are written next to the conversation, under
`<session root>/<conversation id>/uploads/`, and the model is told the paths and
asked to read them.

Next to the conversation, not into the project directory: `--dir` points at the
person's own repository, and a chat window does not get to leave files in it.
The consequence is that the uploads sit outside the CLI's working directory, so
the Gateway passes `--add-dir <that directory>` — without it the read is refused
with an error that reads as though the file is missing.

Limits, both settable:

| | Default | Variable |
|---|---|---|
| Files per message | 10 | `GATEWAY_MAX_ATTACHMENTS` |
| Total size per message | 5 MB | `GATEWAY_MAX_ATTACHMENT_BYTES` |

5 MB decoded is about 6.7 MB of base64, which fits under the router's 8 MB body
cap. Raising it past that makes it unreachable: the request is refused for being
too large before anything counts the attachments.

The filename is never trusted. It arrives in a request body and is about to be
joined to a path, so separators, control characters and leading dots are
stripped before it names anything — `../../etc/passwd` becomes `etcpasswd`
inside the conversation's own uploads directory. Two files of one name become
`log.txt` and `log-2.txt` rather than one file.

Attachments stay on disk for the life of the conversation, so a later turn that
resumes the same session can still read them.

### What you give up, and why

| | Full setup | Personal setup |
|---|---|---|
| Postgres | required | none |
| Brain Core, Brain MCP | required | none |
| Conversations | Postgres | SQLite file |
| Memory | Core's hybrid retrieval | the plugin's |
| Pre-fetch before the first turn | yes | no — the model calls the tools itself |
| Citation chips | yes | no |
| Write-back (learning from chats) | yes | no |
| Concurrent chats | up to `GATEWAY_MAX_CONCURRENCY` | one |

Concurrency is one because the plugin's store is embedded and takes a single
writer; two `claude -p` processes would collide on it.

Three of those absences are the same absence: pre-fetch, citations and
write-back are all Brain Core reading and writing memory itself, and here the
Gateway cannot see memory at all — only the model can, through its tools.

**`CORE_URL=none` also drops Brain MCP**, deliberately. Declaring an MCP server
that is not running does worse than nothing: the model watches the connection
fail and starts discounting whatever memory it does get. That is not a guess —
it said so in its own answer during testing.

### Before you build any of this

If the terminal is enough, you need none of it. `/plugin install dai-memory`
gives you memory inside Claude Code today, with no Gateway, no UI and no
database. The setup above is worth it only if you specifically want the chat
window.


## What it costs, and what stops it

Every message spawns a whole Claude CLI session. That is a real charge against
a real account, and it is worth saying plainly because during this project's
own testing it quietly consumed the author's subscription quota until the
limit hit.

Three things follow from that, and all three are on by default now:

- **A ceiling per conversation.** `GATEWAY_MAX_CONVERSATION_COST_USD` defaults
  to `5`. Over it, the Gateway refuses the turn *before* spawning anything —
  after the process starts the money is already spent. Per conversation rather
  than global, because a runaway is almost always one conversation in a loop
  and a global cap would take everything else down with it. `0` disables it.
- **Every turn is recorded**, per turn rather than as a total, because a total
  cannot answer the only question asked afterwards: which conversation ran
  away. The UI shows the running cost in the status bar, and turns it amber
  past 80% of the ceiling.
- **Two warnings at startup.** Unset `CLAUDE_MODEL` means every turn runs on
  the CLI's default — the expensive one. Unset `ANTHROPIC_API_KEY` means the
  runner bills whatever account the CLI is logged into, which for most people
  is their own subscription.

For a personal chat window:

```bash
export ANTHROPIC_API_KEY=...          # separate billing from your own quota
export CLAUDE_MODEL=claude-sonnet-5   # or cheaper
```

The API key matters even at one user: it keeps a bug in the Gateway from
locking you out of the Claude Code you were using to fix it.

**Write-back doubles the bill** — one extra model call per conversation. It is
off in the personal setup and on in the full one; `GATEWAY_WRITEBACK=false`
turns it off there too.


## Why a database at all

The plugin this grew out of needs no server: it stores everything in files under
the project directory. That is the right answer for what it is — one person, one
machine, one checkout.

DAI Brain is a different shape, and the difference is what costs you a database:

- **It is multi-user by construction.** Scope is `tenant → user → project`, and
  the isolation tests exist because more than one person's memory lives in the
  same store.
- **Two processes write to it.** Core owns memory; the Gateway owns
  conversations, Claude session ids and the write-back queue. An embedded file
  store does not give two processes concurrent writes.
- **The queue needs real locking.** The write-back worker claims jobs with
  `FOR UPDATE SKIP LOCKED`, so a second worker is safe without either knowing
  about the other.
- **The Gateway is stateless on purpose**, so it can run more than one instance.
  That only works if the state is somewhere both instances can see.

If you only ever want memory for yourself on one machine, that is real cost for
no benefit, and the plugin is the better tool for that shape. The two are not
competitors — see *Bootstrapping from a repository* for running them together.

### pgvector is optional

You need Postgres. You do **not** need pgvector. Without it the embedding
column is `real[]` and the vector branch scans it exactly — linear in the number
of items, and it says so in the fusion report and in `/health` rather than
pretending otherwise.

Measured on the eval set, on a store of this size:

| | recall@10 | MRR@10 | p95 |
|---|---|---|---|
| with pgvector (HNSW) | 90.7% | 0.839 | 7ms |
| without, exact scan | 89.6% | 0.834 | 9ms |

The whole suite passes in both modes. The difference is inside the run-to-run
noise at forty items; it is the growth curve that differs, not the answer — an
exact scan is correct at any size and slow at a large one.

To confirm the fallback on a machine that has pgvector installed:

```bash
DAI_DISABLE_PGVECTOR=true pnpm migrate
```

A fallback nobody has run is a fallback nobody should trust.


## How a question is answered

1. The UI posts to `/chat`. The Gateway verifies the JWT and decides the
   scope. This is the only place a scope is decided.
2. Pre-fetch: Core `/search` with a ~1000-token budget. The result goes into
   `--append-system-prompt`, so the first turn has memory before the model
   thinks to ask for it.
3. The Gateway spawns `claude -p` with the memory MCP server wired in and
   `--allowedTools` limited to the four memory tools.
4. Claude may call `memory_search` for more. MCP forwards to Core with the
   scope the Gateway set — the model never sees that header and cannot change
   it.
5. The stream translator maps Claude's `stream-json` onto six SSE events. Tool
   results from `mcp__memory__*` become `citation` events.
6. On a clean turn the transcript is queued for write-back.

## Running on Windows

Two things differ, and one of them will stop you immediately if it is not
handled.

**Node cannot spawn the Claude CLI's `.cmd` shim.** Since the fix for
CVE-2024-27980, `spawn` refuses a `.cmd` without `shell: true` — and a shell is
not an option here, because the prompt is whatever the user typed and it
travels in argv, so under cmd.exe a message becomes a command. The Gateway
steps over the shim instead and runs the CLI's JavaScript entry point with
Node. It finds that entry automatically in the usual npm global layout; when it
cannot, it fails with an instruction rather than an `ENOENT`:

```cmd
npm root -g
set CLAUDE_BIN=%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js
```

**Session directories** default to `%TEMP%\dai-brain-sessions`, not `C:\tmp`.
Override with `GATEWAY_SESSION_ROOT` if you want them somewhere durable.

### The simplest local setup

Run the services in Docker and the ingest CLI on the host. Docker Desktop runs
Linux containers, so the spawn problem does not arise at all, and the ingest CLI
never spawns the Claude CLI:

```cmd
cd infra
copy .env.example .env
docker compose up -d

REM Seed memory from a project on your own disk.
cd ..
pnpm install
pnpm build
set DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain
pnpm ingest:repo C:\Project\Inventory --scope acme/me/inventory --dry-run
pnpm ingest:repo C:\Project\Inventory --scope acme/me/inventory
```

Then set the Gateway's scope to that project and open <http://localhost:8080>.
With `GATEWAY_DEV_SCOPE=acme/me/inventory` in `infra/.env`, every request runs
as that user and project.

The `--dry-run` first is worth the extra minute: it prints what would be
stored, and a repository with no ADRs, no `CONTRIBUTING`, no `CLAUDE.md` and
terse commit messages will produce very little. That is the ingester working
correctly — it reads reasoning, and a repository that never wrote any down has
none to give.

### Running everything natively instead

Works, with `CLAUDE_BIN` set as above. Use a Postgres with pgvector — the
official `pgvector/pgvector:pg16` image is the least trouble even when the rest
runs on the host.


## Use DAI Brain from your own Claude Code

The Gateway writes its own MCP config for the sessions it spawns, so the web UI
needs nothing set up. To reach the same memory from the `claude` CLI in your own
terminal, you register the MCP server yourself.

Core and MCP have to be running first (`pnpm core` and `pnpm mcp`, or
`docker compose up` in `infra/`).

### Option A — one command, just for you

```bash
pnpm mcp:add --scope acme/me/daibrain
```

Or without this repo checked out:

```bash
claude mcp add --transport http dai-brain http://localhost:8082/mcp \
  --header "X-Scope: acme/me/daibrain"
```

Add `--user-scope` (or `-s user` on the raw command) to make it available in
every directory rather than only this one.

Check it:

```bash
claude mcp list
# dai-brain: http://localhost:8082/mcp (HTTP) - ✓ Connected
```

### Option B — committed config, for a team

`.mcp.json` is already in this repo:

```json
{
  "mcpServers": {
    "dai-brain": {
      "type": "http",
      "url": "${DAI_BRAIN_MCP_URL:-http://localhost:8082/mcp}",
      "headers": { "X-Scope": "${DAI_BRAIN_SCOPE}" }
    }
  }
}
```

Everyone shares the file; each person sets their own scope:

```bash
export DAI_BRAIN_SCOPE=acme/your-name/daibrain
```

Copy it into any other repo to use the same memory while working there.

`.claude/settings.json` names this one server in `enabledMcpjsonServers`, so it
loads without a prompt. That is deliberately narrower than
`enableAllProjectMcpServers: true` — approving *this* server is a decision about
a file you can read, while approving all of them is a standing promise about
every `.mcp.json` anyone adds later. Without the setting, run `claude` once
interactively and approve.

### The scope header is mandatory

`X-Scope` is `tenant/user/project` (`*` in the project slot reads across all of
your projects). The MCP server **refuses a request without one** rather than
picking a default — the alternative is guessing whose memory you meant, which is
the cross-user read the whole scope model exists to prevent.

With `DAI_BRAIN_SCOPE` unset, the CLI says so and does not load the server:

```
[Warning] [dai-brain] mcpServers.dai-brain: Missing environment variables: DAI_BRAIN_SCOPE
```

### Things that will confuse you once

- **The server name sets the tool prefix.** Named `dai-brain`, the tools are
  `mcp__dai-brain__memory_search` and so on. Name it `memory` and they match
  what the Gateway allows (`mcp__memory__*`). Either is fine — just be
  consistent with whatever you pass to `--allowedTools`.
- **`claude mcp list` shows project servers as "Pending approval"** even when
  they work. That listing does not consult `enableAllProjectMcpServers`; a real
  session does. Test with an actual run, not the list.
- **This is Core's port (8082), not the Gateway's (8080).** The CLI talks to MCP
  directly. It gets memory, but not the Gateway's pre-fetch, conversation
  history or write-back — those belong to the chat UI.

### Scripted use

To pin exactly one server and ignore whatever else is configured on the machine,
which is what the Gateway does:

```bash
cat > /tmp/dai-mcp.json <<'JSON'
{ "mcpServers": { "memory": { "type": "http", "url": "http://localhost:8082/mcp",
  "headers": { "X-Scope": "acme/me/daibrain" } } } }
JSON

claude -p "what did we decide about the database?" \
  --mcp-config /tmp/dai-mcp.json --strict-mcp-config \
  --allowedTools "mcp__memory__memory_search,mcp__memory__memory_write"
```

`--strict-mcp-config` is the load-bearing flag: without it the CLI merges in the
machine's own MCP servers.


## Giving the UI other tools (Jira, and so on)

Adding a server to your own CLI with `claude mcp add` does **not** make it
available in the web UI. The Gateway writes its own config and passes
`--strict-mcp-config`, which deliberately ignores every MCP server configured
on the host machine — otherwise whatever a developer once ran `claude mcp add`
for would silently join a session serving someone else.

So extra servers are named by the operator, in a file:

```bash
cat > /etc/dai-brain/extra-mcp.json <<'JSON'
{
  "mcpServers": {
    "jira": {
      "type": "http",
      "url": "https://your-jira-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
JSON

export GATEWAY_EXTRA_MCP_CONFIG=/etc/dai-brain/extra-mcp.json
export GATEWAY_EXTRA_ALLOWED_TOOLS="mcp__jira__search_issues,mcp__jira__get_issue"
```

Both are required. `--allowedTools` has no wildcard for MCP, so the tool names
have to be listed — which is not just a limitation to work around: the list is
the audit record of what a web-facing agent may do. A server configured without
its tools listed is reachable by nobody, which is the safe direction to fail in.

Three things this deliberately does:

- **`memory` cannot be shadowed.** Extra servers are merged *under* it. A config
  file that redefined `memory` would point the memory tools at someone else's
  endpoint, which would then be handed this user's scope header on the next
  search.
- **The scope header does not leak.** `X-Scope` is written onto the memory
  server only. What credentials the Jira entry carries are the operator's to
  set, and they are the same for every user.
- **A missing or malformed file fails the turn, loudly.** An operator who
  configured Jira and got a session without it would debug the prompt for an
  hour before suspecting the config.

Per-user credentials are **not** supported: this file is one set of servers for
everyone the Gateway serves. If Jira has to act as the individual user rather
than as one service account, that needs per-request credential injection, which
is not built.


## Bootstrapping from a repository

A fresh store knows nothing, and conversation memory only accumulates by having
conversations. A repository already holds months of reasoning — it is just not
in a form anything can retrieve.

```bash
pnpm ingest:repo /path/to/repo --scope acme/me/myproject --dry-run   # look first
pnpm ingest:repo /path/to/repo --scope acme/me/myproject
```

It reads the part of a repository that is **not** recoverable by reading the
code: ADRs, CONTRIBUTING, CLAUDE.md, architecture docs, README sections that
argue for a choice, and commit messages with a body. A file's intent sets the
type (an ADR is a `decision`, CLAUDE.md is a `preference`), and a section that
argues for something is promoted to `decision` wherever it lives.

Everything goes through the normal write path, so the privacy filter and the
reconciler both apply. Re-running is safe: unchanged sections come back
`duplicate`, an edited one supersedes its older phrasing. Every item keeps its
provenance — `repo:docs/adr/0001-use-rrf.md#use-rrf`, `git:3d05af4c9579`.

### What it deliberately does not do

It does not index code. Symbols, call graphs and file structure are derived
data: they go stale on the next commit, and an agent with the repo checked out
can read them directly and get today's answer instead of last week's.

If you want code-structure questions answered — what calls this, what breaks if
I change it — the [DAI memory layer plugin](https://github.com/Exia-thd/DAI-memory-layer-plugin)
already does that across 29 languages, and the two run side by side as separate
MCP servers. Claude gets `mcp__dai-brain__memory_*` for cross-project
conversation memory and `dai_memory_*` for this repo's code graph.

### Why a CLI and not an endpoint

An HTTP endpoint taking a server-side filesystem path would let anyone holding
a token turn any file the Core process can read into a memory they can then
retrieve — arbitrary file disclosure wearing an ingestion API's clothes. The
operator running the CLI already has the filesystem, so it gives away nothing
new.


## Retrieval

`POST /search` runs five steps:

| Step | What it does | Why it is there |
|---|---|---|
| Vector | pgvector ANN, or an exact scan without it | Generalises across wording |
| Graph | Entity-link the query, expand 1–2 hops | Finds what is *associated*, not just what resembles |
| FTS | Postgres `tsvector`, `simple` config | Exact identifiers, flags, version numbers |
| RRF | Reciprocal rank fusion, weighted | The three scores share no scale; ranks are all they agree on |
| Rerank | Optional, behind an interface | RRF is rank-only, so it cannot tell a decision from a note |

The three branches run concurrently and each catches its own failure, so a
broken branch costs recall rather than the request. Every branch that
contributed nothing is named in the fusion report with a reason:

```json
"fusion": {
  "branches": { "vector": 7, "fts": 1, "graph": 0 },
  "degraded": ["graph"],
  "reasons": { "graph": "no entity in this scope matched the query text" }
}
```

A branch that returns empty and says nothing is how a hybrid quietly decays
into whichever branch still works. The memory explorer shows this report for
every search, which makes it the fastest way to diagnose bad recall.

### The vector index

HNSW, not IVFFlat, and the difference is not a preference.

IVFFlat has to be *trained*: it clusters the vectors already in the table into
`lists` buckets, and a query at the default `probes = 1` scans exactly one
bucket. Built at migration time the table is empty, so the centroids mean
nothing. Measured on a 62-item store, an IVFFlat index the planner chose
returned **1 row of 62** where an exact scan returned all 62 — and reported
itself perfectly healthy while doing it.

That is the worst shape a bug can take here: the branch does not fail, so it is
never marked degraded, and every recall number downstream is measured against a
fraction of the store.

HNSW needs no training data, so it is correct on an empty table and stays
correct as the store grows without anyone retuning `lists` and `probes`. Below
pgvector 0.5 there is no HNSW, and the migration then builds **no** index at
all: an exact scan is linear but complete, which is the right trade.

`pnpm migrate` repairs an existing database — migration `002` drops the old
index and rebuilds it. `/health` reports an IVFFlat index it finds as
`degraded`, naming the fix.


### The token budget packer

`maxTokens` is a hard cap. No single item may take more than 35% of it, so one
long artifact cannot crowd out five short decisions, and packing continues past
an item that did not fit. Anything dropped is counted in `omitted` — a limit
answers "how much", never "how much was there".

## Evaluation

```bash
pnpm eval              # one configuration, plus the queries it missed
pnpm eval --compare    # vector-only vs. all branches vs. 2-hop vs. rerank
```

45 hand-judged queries over a 40-item corpus, English and Vietnamese, in
`eval/data/`. `relevant` lists what genuinely answers each question — judged by
hand, never by what the retriever happened to return, which is how an eval set
stops measuring anything.

Current numbers, on the **hash** embedder (see below — these are a floor):

```
all branches, no rerank      recall@5 84.4%   recall@10 90.7%
                             MRR@10 0.839     p95 7ms
vector+fts only (graph off)  recall@5 81.1%   recall@10 89.6%   MRR@10 0.804
all branches, 2-hop graph    recall@5 84.4%   recall@10 89.6%   MRR@10 0.838
all branches + rerank        recall@5 82.2%   recall@10 88.5%   MRR@10 0.847
```

So graph expansion is worth about 4 points of MRR at one hop and nothing at
two, and the reranker trades a little nDCG for a little MRR. Those are the
kinds of numbers the branch weights should move on.

Expect roughly ±1 point between runs: `ivfflat` is an approximate index, and
its behaviour shifts with what else is in the table. Treat a one-point move as
noise and a five-point move as a result.

Both remaining misses need semantic generalisation the hash embedder does not
have ("what language should new services be written in?" → a memory that says
*TypeScript* and never says *language*). They are the cases a real embedder is
for.

For CI, `--min-recall 0.85 --max-p95 500` makes the run fail rather than report.

## Embeddings

`hash` is the default: deterministic, offline, no download, so a fresh checkout
and the eval both work with nothing to fetch. It is lexical only — two
paraphrases sharing no words land far apart. **Recall measured on it is a
floor, not a forecast.**

```bash
DAI_EMBEDDING_PROVIDER=transformers DAI_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
```

`DAI_EMBEDDING_DIMS` must match the model and is **fixed at migration time**,
because it is the width of a `vector(N)` column. Changing it after data exists
needs a fresh store and a re-ingest.

## Scope

`tenant → user → project`. Every query carries one, and **a scope never comes
from a model**.

- The Gateway decides it, from verified JWT claims, in `scopeFor()`.
- It travels as `X-Scope: tenant/user/project` (`*` for all projects).
- Core trusts that header completely — which is only sound because the Gateway
  is the only thing that can reach Core. In `infra/docker-compose.yml` only the
  Gateway publishes a port.
- `scopeWhere()` is the only way a scope becomes SQL. There is no variant that
  takes an optional scope.
- Entity ids are derived from the scope, so two users who both wrote about
  "Deployment" have two nodes, not one shared one.
- The search cache is keyed by scope. A cache keyed by query alone is the
  cheapest possible cross-user leak, and it passes every single-user test.

`tests/scope-isolation.test.js` covers all of this.

## Write-back

Gateway queues the transcript → worker claims it (`FOR UPDATE SKIP LOCKED`) →
a cheap model extracts candidate facts → the privacy filter runs → the
reconciler decides.

Four outcomes: `rejected` (a secret, or confidence below the floor),
`duplicate` (same normalised content), `superseded` (a near neighbour above the
similarity threshold — the old row is marked, never deleted), `inserted`.

**Undo.** Every derived item carries its `conversation_id`, so:

```bash
curl -X DELETE localhost:8080/conversations/conv_abc/memory
```

removes everything one run created, and nothing a person wrote by hand.

Start strict. `GATEWAY_WRITEBACK_MIN_CONFIDENCE=0.6` is a floor to loosen with
evidence, not a default to lower because the store looks empty.

## Privacy filter

Provider API keys, private key blocks and JWTs **reject** the whole item.
Assignment-shaped secrets (`DB_PASSWORD=…`), database URL passwords, bearer
tokens and emails are **masked**, keeping the sentence and losing the value.
Card numbers are masked only when they pass Luhn, so version strings and
timestamps survive.

A secret in memory is worse than one in a log: it will be retrieved, packed
into a system prompt, and sent to a model on every later question that
resembles the one that captured it.

## Tests

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain_test
pnpm migrate
pnpm test
```

Tests needing a database skip themselves when there is none, rather than
failing. Each one gets a fresh project scope, so they never see each other's
data.

## Configuration

**Core** — `DATABASE_URL`, `CORE_PORT`, `DAI_EMBEDDING_PROVIDER`,
`DAI_EMBEDDING_MODEL`, `DAI_EMBEDDING_DIMS`, `DAI_SEARCH_MAX_TOKENS`,
`DAI_SEARCH_LIMIT`, `DAI_GRAPH_DEPTH`, `DAI_DEDUPE_THRESHOLD`,
`DAI_SEARCH_CACHE_TTL_MS`, `DAI_DISABLE_PGVECTOR`.

**Gateway** — `GATEWAY_PORT`, `CORE_URL`, `MCP_URL`, `CLAUDE_BIN`,
`CLAUDE_MODEL`, `GATEWAY_MAX_CONCURRENCY`, `GATEWAY_REQUEST_TIMEOUT_MS`,
`GATEWAY_SESSION_ROOT`, `GATEWAY_PREFETCH_TOKENS`, `GATEWAY_JWT_SECRET`,
`GATEWAY_DEV_SCOPE`, `GATEWAY_WRITEBACK*`, `GATEWAY_EXTRA_MCP_CONFIG`,
`GATEWAY_EXTRA_ALLOWED_TOOLS`, `GATEWAY_SQLITE_PATH`,
`GATEWAY_MAX_CONVERSATION_COST_USD`, `GATEWAY_MAX_ATTACHMENTS`,
`GATEWAY_MAX_ATTACHMENT_BYTES`. Leaving `DATABASE_URL`
unset selects the SQLite store; `CORE_URL=none` drops Brain Core and Brain MCP.

**MCP** — `MCP_PORT`, `CORE_URL`.

### Authentication for the CLI

If DAI Brain serves more than one person, run the CLI on `ANTHROPIC_API_KEY`
rather than a personal subscription login: this process serves whoever holds a
token, and a subscription is issued to a person. Check Anthropic's terms for
your own case.

## Known limitations

- **The vector branch has no similarity floor.** It is k-nearest, so it always
  returns its `k` neighbours however unrelated. RRF and the token budget
  mitigate it, but a threshold is a real tuning knob — one the eval should
  decide, not taste.
- **The reranker is heuristic**, not a cross-encoder: it blends query coverage,
  memory type and recency. `Reranker` is an interface so a real model can
  replace it; the eval says whether the latency is earned.
- **Relations are co-occurrence only.** `RELATES_TO` means these names appeared
  in the same memory. Nothing yet infers *how* they relate.
- **Write-back has no scheduled sweep.** It runs per conversation; there is no
  periodic pass to merge or decay memory across conversations.
- **Memory decay is not implemented.** Recency is a reranker term, not a
  background process that lowers the standing of old, unused items.
- **The UI does not render markdown.** Answers are inserted with
  `textContent`, so `**bold**` shows its asterisks. That is the safe default
  for text that is model output; rendering it needs a sanitising parser, not a
  regex.
- **Observability is console logging.** The tracing the plan wants (Langfuse or
  OpenTelemetry across pre-fetch, tool calls, tokens and latency) is not built.

## Licence

MIT.
