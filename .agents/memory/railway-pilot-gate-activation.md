---
name: Railway pilot gate activation
description: Non-obvious Railway control-plane behavior encountered while activating guarded production features.
---

Verify request-time feature gates through an authenticated production route, not from a deployed SHA, health check, or checked-in Railway start command alone. An attached Railway MCP connection may have no mounted callbacks or generated skill files, and a root multi-service start-command override may deploy without becoming the service's effective command.

**Why:** During the DM-001 rollout, the new SHA and health check were live while the authenticated pilot route still returned the gate's 404. The managed connection was attached but exposed no callable tools, and the committed start-command environment prefix was ignored.

**How to apply:** After schema and operational checks pass, activate through the available Railway control plane. If that path is unavailable, use an explicit, traceable release activation and verify the real authenticated route before treating gates as enabled.