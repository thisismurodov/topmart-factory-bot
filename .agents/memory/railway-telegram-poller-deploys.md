---
name: Railway Telegram poller deploys
description: Railway health, overlap, and logging rules for Telegram long-polling workers
---

Railway Telegram workers must open the assigned `PORT` immediately, expose a lightweight `/healthz`, and use that path as the service health check. Keep `overlapSeconds` at `0`.

**Why:** A long-running bot can poll Telegram successfully yet Railway will terminate it after roughly 90 seconds if a web-configured service never opens a port. Rolling overlap can also run two `getUpdates` pollers with one token.

**How to apply:** Start the health server before database initialization, configure `/healthz`, keep zero overlap in every Railway config, and wait beyond the platform timeout before declaring success. Keep `httpx`/`httpcore` below INFO because Bot API request URLs contain the token.