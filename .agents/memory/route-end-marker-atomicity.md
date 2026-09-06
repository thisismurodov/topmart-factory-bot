---
name: Route-end marker atomicity
description: Once-only gate markers (unique-row "did it already run" guards) must commit in the same transaction as the work they gate.
---

Rule: when a unique marker row gates once-only work (e.g. distribution vehicle route-end report + auto-replenishment), the marker INSERT and the gated work must commit in ONE transaction. Never marker-commit-first + try/except-log around the work.

**Why:** Architect review caught this as the sole severe F11 issue: marker committed first, replenishment failure only logged → every later retry saw the marker and exited, so a transient DB/config error permanently suppressed that day's auto-replenishment with no operator signal.

**How to apply:** Give the worker function an optional marker param that inserts `ON CONFLICT DO NOTHING RETURNING id` at the top of its existing transaction (`None` fetch → lost the race → return early). Any exception rolls back marker + work together, so the next trigger retries the whole finalize. The gated work itself must stay idempotent (partial-unique/op-key dedup) because a crash after commit-competitor scenarios still re-run it. Post-commit Telegram sends may still be lost once — acceptable; the DB side self-heals. Test recipe: patch an inner helper to raise a non-swallowed error type, assert marker AND work rows are both absent, then retry and assert both appear together.
