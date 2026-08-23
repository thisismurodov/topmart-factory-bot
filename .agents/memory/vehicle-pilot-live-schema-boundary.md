---
name: Vehicle test DB isolation
description: Prevents vehicle schema and lifecycle tests from accidentally selecting a runtime database.
---

Vehicle initializer, drift, fresh-database, and lifecycle tests must use an isolated loopback database admin URL, either explicitly supplied or provisioned ephemerally by the test runner. Never fall back to deployment/runtime database URLs for test provisioning.

**Why:** The Python distribution initializer gives `RAILWAY_DATABASE_URL` precedence over `DATABASE_URL`; an inherited runtime variable can silently redirect an intended local test run.

**How to apply:** Accept only a dedicated loopback vehicle-test admin URL; if absent, create a disposable local cluster. Derive child database URLs from it and remove inherited runtime DB variables before invoking the bot initializer.