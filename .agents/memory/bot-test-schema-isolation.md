---
name: Telegram-bot test schema isolation
description: How bot unittest modules must isolate throwaway schemas without breaking combined discovery
---

Rule: bot test modules must NOT mutate `os.environ["DATABASE_URL"]` at import time. `bot.database` copies the URL into a module global on first import, so under combined `unittest discover` only the first-imported module's schema wins and every other module connects to the wrong schema.

**Why:** a code review rejected a task after a second env-mutating test module broke repo-wide discovery for both modules.

**How to apply:** use `tests/_db_isolation.py` — patch `bot.database.DATABASE_URL` in `setUpClass` (via `point_db_to_schema`) and restore in `tearDownClass`; make schema names unique per run (pid+timestamp). `tests/` needs `__init__.py` for discovery. Minimal table clones in tests drift from bot code over time — run full discovery, not just the new module.
