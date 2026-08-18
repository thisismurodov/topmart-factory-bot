---
name: GitHub→Railway deploy pipeline
description: How workspace code reaches Railway; stale-lock pitfall that silently froze sync; deploy IDs vs git SHAs; owner commits directly on GitHub
---
- Deploy path: workspace git `origin` remote (github.com/thisismurodov/topmart-factory-bot, PAT embedded in URL) → GitHub `main` → Railway auto-builds BOTH services (keen-energy = Node API server; topmart-factory-bot = zavod bot worker). Pushing from the workspace works — no external clone needed.
- **Why sync silently froze for a month:** a stale `.git/refs/remotes/origin/main.lock` (created mid-July) blocked every ref update since: `git fetch` said "reference already exists", `git push` said "another git process seems to be running". Meanwhile commits piled up locally and Railway kept building month-old code.
- **How to apply:** any "Railway runs old code" or odd fetch/push ref error → compare `git rev-parse HEAD` vs `git ls-remote origin main`, then look for stale `*.lock` under `.git/` (check mtime; delete only when no live git process). Push output may embed the PAT — pipe through `sed -E 's/ghp_[A-Za-z0-9]+/***/g'`.
- Railway deploy cards show 8-hex deployment IDs (e.g. 87305d84) that are NOT git SHAs — never hunt for them in git history; identify deployed code by stack traces or a /version endpoint instead.
- The owner (Elyorbek) commits to GitHub main from outside the workspace (e.g. 04-avg savdo-bot pagination+search). ALWAYS `git fetch` and inspect `main..origin/main` before pushing; merge and preserve their commits, never force-push.
- Stale deploys also corrupt DATA, not just behavior: the month-old bot wrote kg kirims as dona (qty>0, weight 0) for kg products. After fixing a stale pipeline, audit stock_movements made during the stale window (kg-unit products with qty>0 & weight=0) and fold qty into weight_kg.
