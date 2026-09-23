# Tests

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/daibrain_test
pnpm build && pnpm migrate && pnpm test
```

Everything needing a database calls `databaseAvailable()` and **skips** rather
than fails without one, so a green run with no Postgres has not tested storage.
Check the skip count.

Each database-backed file takes a fresh project scope from `freshScope()` and
cleans up after itself, so files never see each other's memories and can run in
any order.

| File | What it protects |
|---|---|
| `scope.test.js` | The scope model, and the header encoding that must stay injective |
| `scope-isolation.test.js` | The top risk in the plan: one user reading another's memory, across every read path |
| `redact.test.js` | The privacy filter, including that its global regexes do not carry state between calls |
| `packer.test.js` | The token budget is never exceeded, and no single item eats it |
| `fusion.test.js` | RRF ordering, weights, determinism, and that a degraded branch is always named |
| `vector-index.test.js` | That the vector branch sees the whole store: the IVFFlat index it replaces returned 1 row of 62 while reporting itself healthy |
| `retrieval.test.js` | The pipeline end to end against a real database |
| `jwt.test.js` | Signature verification, `alg: none`, expiry, and that a token cannot reach a project it was not granted |
| `semaphore.test.js` | Concurrency limits, cancellation while queued, no double-release |
| `translate.test.js` | Claude's stream → the six UI events, including citations and unknown-line tolerance |
| `repo-ingest.test.js` | Markdown sectioning (fences are not headings), what is ingested and what is skipped, and that re-running does not duplicate |
| `runner-mcp-config.test.js` | What the runner hands the CLI: that `memory` cannot be shadowed by an operator's extra config, and that a broken config fails loudly |
| `writeback.test.js` | Extraction parsing against whatever a model emits, plus reconciliation and undo |
