---
name: Vehicle test DB isolation
description: Prevents vehicle schema and lifecycle tests from accidentally selecting a runtime database.
---

Vehicle initializer, drift, fresh-database, and lifecycle tests must use an explicit isolated loopback database admin URL. Never fall back to deployment/runtime database URLs for test provisioning.

**Why:** The Python distribution initializer gives `RAILWAY_DATABASE_URL` precedence over `DATABASE_URL`; an inherited runtime variable can silently redirect an intended local test run.

**How to apply:** Require a dedicated vehicle-test admin URL, reject non-loopback hosts, derive child database URLs from it, and remove inherited runtime DB variables before importing or invoking the bot initializer.