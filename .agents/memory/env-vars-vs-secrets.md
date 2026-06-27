---
name: setEnvVars writes to tracked .replit — never for credentials
description: Why machine-generated shared keys must go in the Secrets store, not env vars.
---

# setEnvVars persists to `.replit` (git-tracked) — keep credentials out

`setEnvVars` writes shared/dev/prod values into the `[env]` section of `.replit`,
which is committed to the repo. Any credential placed there (API keys, shared
internal auth keys, tokens) is a committed-secret exposure and will fail code review.

**Rule:** anything that functions as a credential — even a value YOU generate, like a
bot↔API shared internal key — must live in the Secrets store, not env vars.

**How to apply:** the Secrets store cannot be written programmatically. Use
`requestEnvVar({requestType:"secret", keys:[...]})` and let the user save it; you may
put a ready-to-paste generated value in the `userMessage`. Secrets are injected into
every workflow's `process.env` at runtime (same as TELEGRAM_BOT_TOKEN), so server +
bot read them normally. Non-sensitive config (ports, hostnames, base URLs) is fine in
`setEnvVars`.

**Why:** observed live — a generated `AI_INTERNAL_KEY` set via setEnvVars landed in
`.replit` and was flagged as credential exposure; moved to a Secret to resolve.
