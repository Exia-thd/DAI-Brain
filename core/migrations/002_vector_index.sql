-- The ANN index for embeddings.
--
-- Split out of 001 because the right index depends on the installed pgvector
-- version, and because the one this replaces was wrong in a way that did not
-- announce itself: an IVFFlat index created at migration time is trained on an
-- empty table, and at the default probes = 1 a query scans a single cluster.
-- Measured on a 62-item store, that returned 4 rows where an exact scan
-- returned 62 -- the vector branch quietly answering with a fraction of the
-- store while reporting itself healthy.
--
-- The runner substitutes the statement below from the live pgvector version:
-- HNSW where available (no training data needed, so correct on an empty table),
-- and otherwise no index at all, because an exact scan is slower and right.

{{VECTOR_INDEX}}
