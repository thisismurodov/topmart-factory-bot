---
name: react-query single-gate rule
description: Splitting loading/error gating for one query across parent+child components causes an infinite refetch storm
---

**Rule:** For any react-query query that gates rendering (e.g. auth "me" query), exactly ONE stably-mounted component may early-return on its pending/error state. No ancestor of that gate may early-return on the same (or any) query's state.

**Why:** In the Field Assistant Mini App, AppLayout early-returned a spinner on `isLoading` while its child AuthGate early-returned on `isError`. The two gates unmounted/remounted each other; every remount triggered `refetchOnMount` on the stale errored query, producing hundreds of 401s per second until the API rate limiter returned 429 — and the UI showed an infinite spinner. Retry config alone did NOT stop it (retries were disabled for 401; the loop was mount-driven, not retry-driven).

**How to apply:** Put spinner + error screens + success-children all inside one gate component that never unmounts (mounted directly under a query-agnostic layout shell). Give shared queries a `staleTime` (e.g. 60s) so extra subscribers on child pages don't refire on mount. When debugging a request flood: millisecond-spaced repeats mean a mount loop, not retries (retry delays are ≥1s exponential). Also note: a stale HMR browser tab can keep an old broken bundle looping even after the fix — the storm in server logs may predate the currently served code.
