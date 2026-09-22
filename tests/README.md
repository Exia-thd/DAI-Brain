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
| `retrieval.test.js` | The pipeline end to end against a real database |
| `jwt.test.js` | Signature verification, `alg: none`, expiry, and that a token cannot reach a project it was not granted |
| `semaphore.test.js` | Concurrency limits, cancellation while queued, no double-release |
| `translate.test.js` | Claude's stream → the six UI events, including citations and unknown-line tolerance |
| `writeback.test.js` | Extraction parsing against whatever a model emits, plus reconciliation and undo |
