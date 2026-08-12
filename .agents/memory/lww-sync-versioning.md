---
name: Last-write-wins sync needs server-side versioning
description: Pattern for syncing client-saved state (e.g. field route order) across devices without races
---
Rule: when a client persists user state to the server with fire-and-forget PUT/DELETE, client-side sequence guards are NOT enough — a delayed old PUT can arrive after a newer DELETE and resurrect the record. Completion code review rejects this.

**Why:** network completion order ≠ user action order; only the persistence boundary can enforce ordering.

**How to apply:** add a client-generated monotonically increasing `op_seq` (Date.now(), +1 on same-ms) column; upsert with `ON CONFLICT ... DO UPDATE ... WHERE existing.op_seq < EXCLUDED.op_seq RETURNING id` (applied = rows.length>0); model reset as a tombstone row ('[]') via the same conditional upsert, never a hard DELETE; retries must resend the ORIGINAL op_seq (persist it in the dirty flag). Test by applying an older op after a newer one in Postgres and asserting it's rejected.
