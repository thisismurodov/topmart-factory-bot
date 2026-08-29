---
name: E2E testing the auth-gated dashboard
description: How to run Playwright e2e tests against the bcrypt-login dashboard without real credentials
---

The dashboard login is bcrypt-hashed `admin_users` + `admin_sessions` tokens in the central Postgres (`RAILWAY_DATABASE_URL` first, not dev `DATABASE_URL`).

**How to apply:** For e2e runs, insert a throwaway admin (`bcrypt.hash` via a node one-liner from `artifacts/api-server` dir so `pg`/`bcryptjs` resolve), pass its credentials in the test plan, then delete the user AND its `admin_sessions` rows afterwards. For curl-level API checks, a manually inserted `admin_sessions` token is enough (no expires column) — clean it up too. API routes (incl. vehicle pilot) want `Authorization: Bearer <token>` from the login response — cookie-jar-only curl gets 401 "Not authenticated". psql only interpolates `:'var'` from stdin/heredoc, never via `-c`.

**Why:** Real admin passwords are unknown/hashed; screenshot tool can't authenticate, so the login-wall makes UI verification impossible without this.
