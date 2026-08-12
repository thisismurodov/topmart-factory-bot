---
name: Distribution route planner design
description: Constraints and gotchas of the AI route-planning engine (balanced k-means + NN/2-opt).
---

# Distribution route planner

- Planner = balanced k-means (capacities base/base+1 so every shop assigned exactly once) → nearest-neighbor + 2-opt per day.
- **Outliers must be filtered BEFORE clustering**: shops whose GPS sits >60km from the region median (wrong coords, e.g. Tashkent GPS on a Namangan shop) otherwise wreck km stats and day balance. They are returned as `badCoord[]` for the user to fix — never silently included.
- **Scale limit**: days are capped at 6 (juma=5 is rest day), so a viloyat with more than ~6×28 shops forces per-day counts above the 22–28 target. Fine for current data; revisit if a region grows past ~168 shops.
- **Why:** spec demands 22–28 shops/day and no zig-zag; balanced capacities + 2-opt gave both without an external solver.
- **How to apply:** any new region planning goes through the same lib; don't add a second ad-hoc assignment path. Save is transactional DELETE+INSERT per agent; concurrent saves aren't guarded by a UNIQUE constraint (single-admin assumption).

## v2 additions (multi-start + validation)

- Ordering = multi-start NN (several start points) + 2-opt + Or-opt + uncross loop until 0 segment crossings. Real-data effect: −25% km vs v1 on the same shops.
- **`driveMinutes` is PURE drive time (km/25)**; visit time is separate (`visitMinutes` = n×5). Any UI/report showing "route time" must use `totalMinutes`. Old semantics (drive+visit combined) died in v2 — don't resurrect.
- `validatePlan()` runs before save: duplicates/missing shops/broken tartib/crossings → HTTP 422, plan NOT saved. Planner is deterministic, so if a crossing ever survives optimization, that viloyat+agent becomes unsavable — escape hatch would be a `force` flag, not downgrading the check to a warning.
- **v3 (Aug 2026)**: daily target raised 25→30 (defaults in planRoutes + computeRouteStats + dashboard copy). `splitTerritories(shops, caps[])` exported for multi-agent capped territory split (balanced k-means + swap); one-off `route-split-cli.ts` splits shops between two agents in ONE transaction with locked-shop overlap check and empty-secondary guard. All dokonlar viloyat text was normalized to Namangan (old "Farg'ona" labels were agent-entered, GPS proved all shops are in Namangan region).
- **Score calibration is strict**: sparse rural viloyats legitimately score 41–85 (long hops dominate); dense urban data hits 95+. Score numbers are NOT comparable across formula versions — compare km, not score, when judging planner changes.
- **Fixed start point (Aug 2026)**: all daily orderings are oriented from the Dang'ara warehouse base (`startPoint`) — NN seeding, 2-opt/Or-opt evaluation, and km stats all measure from base, not from an arbitrary first shop. Don't reintroduce pure multi-start NN that picks a random start: it silently re-orients routes away from the depot and km comparisons vs old plans become meaningless.
