---
name: Pathless auth-wall ordering in api-server
description: Routers with their own dedicated auth must be mounted before ALL pathless auth walls in routes/index.ts, and how to recognize this failure fast.
---

Rule: in api-server `routes/index.ts`, `requireAuthOrInternalKey` is mounted PATHLESS several times (`router.use(requireAuthOrInternalKey, someRouter)`), so it runs for EVERY request that reaches it — not just that router's paths. Any router that carries its own dedicated auth (e.g. vehicle bot-key routers using `x-vehicle-distribution-bot-key`) must be mounted BEFORE every pathless wall, not merely before the global `requireAuth`.

**Why:** The vehicle handoff routers were mounted after the ai/ombor/suggestions walls; bot requests carry neither Bearer nor `x-internal-key`, so the first pathless wall 401'd them before they ever reached their own auth. This burned hours chasing "secret mismatch" across Replit production secrets, deployment secret sync, and Railway variables — while dev+prod hash-identical keys kept failing.

**How to apply / recognize:**
- Instant (~2ms) `401 {"error":"Not authenticated"}` with a KNOWN-good key, identical in dev and prod, means middleware ordering — reproduce against the dev server FIRST before touching secrets or deployments.
- Each vehicle router applies its own fail-closed wall to every route it registers (`makeHandoffAuth`, `botAuth`, `makeWeeklySummaryAdminAuth`), so mounting them early leaks nothing.
- In dev, a valid bot key yields 404 from `vehicleDistributionGate` because `VEHICLE_DISTRIBUTION_ENABLED` is unset there (production-only flag). 404-with-key in dev = gate, not routing.
- Composition bugs like this are invisible to router-level unit tests; only tests importing `routes/index.ts` (e.g. distribution-fresh-db/analytics) exercise mount order.
