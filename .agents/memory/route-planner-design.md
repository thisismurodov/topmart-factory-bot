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
