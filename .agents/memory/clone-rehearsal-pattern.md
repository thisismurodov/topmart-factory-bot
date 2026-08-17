---
name: Clone rehearsal for destructive DB ops
description: How to rehearse destructive prod SQL (reset/migration GO scripts) on a clone; local nix-PG cluster pattern and its pitfalls.
---

# Clone rehearsal for destructive DB ops

**Rule:** before running a destructive single-transaction GO script on prod, restore the latest prod dump into a clone and run the full GO + verify there. The rehearsal catches compile-time PL/pgSQL errors (e.g. RAISE placeholder/param count mismatch) that no amount of reading catches — those abort mid-script, and the single-txn + gates design proved it rolls back cleanly.

**Why:** two script bugs surfaced only at rehearsal runtime; both aborted with zero damage. Empirical execution on a clone is stronger validation than review for ops SQL.

**How to apply:**
- **Remote clone on the same server is too slow from the workspace**: pg_restore does per-object round trips (~1800 TOC entries blew past the 300s tool limit even with `-j 8`; pre-data section is always serial). Don't fight it.
- **Local cluster instead**: nix PG18 binaries (`/nix/store/*postgresql-18*/bin`) include initdb/pg_ctl. As root, run initdb/pg_ctl via `su nobody -s /bin/bash <script>` (initdb refuses root); socket dir `/tmp/pgsock` chmod 777; start with `-c listen_addresses='' -c fsync=off`. Local restore of the same dump: <1s.
- **fsync=off + sandbox SIGKILL reverts sequences**: table data survives (OS flushes pages) but sequences revert to last checkpoint → duplicate-pkey on next insert. After every restart, resync ALL sequences via pg_depend→`setval(seq, max(col))` generator piped to psql; run `CHECKPOINT;` after milestones.
- **This workspace sets PGDATABASE=heliumdb**: psql without `-d` connects to it and fails confusingly. Always pass `-d` explicitly for local/maintenance connections.
- **bash quirk**: `"${1:?msg}"` breaks parsing if msg contains an apostrophe (quote parsing inside `${}` within double quotes) → "unexpected EOF looking for matching quote" at EOF line. Keep `:?` messages apostrophe-free.
