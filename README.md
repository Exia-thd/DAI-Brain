# DAI Brain

**English** · [Tiếng Việt](README.vi.md)

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
all branches, no rerank      recall@5 83.3%   recall@10 90.4%
                             MRR@10 0.843     nDCG@10 0.825    p95 8ms
vector+fts only (graph off)  recall@5 81.1%   recall@10 89.3%   MRR@10 0.804
all branches, 2-hop graph    recall@5 83.3%   recall@10 89.3%   MRR@10 0.831
all branches + rerank        recall@5 83.3%   recall@10 89.3%   MRR@10 0.847
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
`DAI_SEARCH_CACHE_TTL_MS`.

**Gateway** — `GATEWAY_PORT`, `CORE_URL`, `MCP_URL`, `CLAUDE_BIN`,
`CLAUDE_MODEL`, `GATEWAY_MAX_CONCURRENCY`, `GATEWAY_REQUEST_TIMEOUT_MS`,
`GATEWAY_SESSION_ROOT`, `GATEWAY_PREFETCH_TOKENS`, `GATEWAY_JWT_SECRET`,
`GATEWAY_DEV_SCOPE`, `GATEWAY_WRITEBACK*`.

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
