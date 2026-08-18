---
name: Replit AI proxy is sidecar-local
description: AI_INTEGRATIONS_OPENAI_* point to a 127.0.0.1 sidecar; unusable outside Replit; keep shared AI clients lazy-init.
---

**Rule:** `AI_INTEGRATIONS_OPENAI_BASE_URL` is a loopback address (`http://127.0.0.1:<port>`) — a Replit sidecar proxy that exists only inside the Replit workspace and Replit deployments. The matching API key is a short proxy token, not a real OpenAI key. Copying these vars to an external host (Railway, VPS) can never work.

**Why:** an externally deployed API crash-looped after a push because a shared AI client asserted these vars at module import; significant time was lost copying the vars to the external host before noticing the value is loopback-only.

**How to apply:**
- Shared AI clients must lazy-init: import never throws; the first actual AI call throws a clear error when env is missing. Never reintroduce module-level env asserts in code bundled for external deploys.
- Deploy external hosts WITHOUT these vars — delete them if someone added them (a loopback value turns the clear "AI off" error into confusing network failures). Non-AI routes work; AI routes fail loudly per-request.
- AI features keep working via the Replit deployment, which gets the sidecar automatically.
