# Working on DAI Brain

## Layout

`shared/` has no dependencies and everything else imports it. `core/` owns all
retrieval. `mcp/` and `gateway/` are adapters and must stay thin — retrieval
logic that ends up in either one is the change that makes the CLI
unreplaceable.

## Rules that are not stylistic

**Never build a scope predicate by hand.** `scopeWhere()` in
`core/src/storage/scope-sql.ts` is the only way a scope becomes SQL. A missed
predicate is a cross-user read, and the way that bug ships is a hand-written
WHERE clause that forgot one column.

**A scope never comes from a model.** The Gateway decides it in `scopeFor()`
from verified JWT claims. Core trusts `X-Scope` completely, and that trust is
only sound while the Gateway is the only thing that can reach Core.

**Nothing is deleted silently.** Items are superseded. Anything write-back
creates carries its `conversation_id` so it can be rolled back.

**A degraded branch says so.** If a retrieval branch falls back or returns
nothing, it names itself in the fusion report with a reason. A branch that
fails quietly is how the hybrid decays into whichever branch still works.

**Never widen an error into a 500.** `ScopeError` is a 400. A privacy
rejection is an outcome, not an exception.

## Before changing retrieval

Run the eval, change one thing, run it again:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain_test
pnpm build && pnpm eval --compare
```

Branch weights, the RRF constant, graph depth and the rerank blend are all
tuning knobs. Move them with a number, not an intuition. If a change improves
recall but the corpus is 40 items, say that out loud.

When you add a retrieval behaviour, add a query to `eval/data/queries.json`
that would fail without it. Judge `relevant` by reading the corpus, never by
running the retriever — an eval set built from its own output measures nothing.

## Tests

```bash
pnpm build && pnpm test
```

Database-backed tests skip themselves without a `DATABASE_URL`, so a green run
with no Postgres has not tested storage. Each test file takes a fresh project
scope from `freshScope()`.

## Two things that have already bitten

**Migration placeholders are plain text substitution.** `001_init.sql` has its
placeholders substituted before Postgres sees it, including inside comments.
Naming them in a comment splices multi-line SQL into a `--` line and breaks the
file. Do not mention them by name in that file.

**The runner's environment is built, not inherited.** `childEnv()` drops every
`CLAUDE_*` variable. Inheriting them means the host's session id becomes the
child's, and several conversations end up bound to one Claude session with
their histories merged.

## Comments

Explain why, not what. The unusual choices here — RRF over score blending,
`simple` over `english` for FTS, superseding over deleting, one MCP server
instance per request — are all decisions someone will want to reverse later,
and the comment is what tells them what it costs.
