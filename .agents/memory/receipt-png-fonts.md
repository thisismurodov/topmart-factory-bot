---
name: Pillow receipt PNG fonts
description: Why receipt/image fonts must be bundled in-repo instead of loaded from system paths.
---

# Pillow image fonts must be bundled, not system-loaded

When rendering images with Pillow (`ImageFont.truetype`), load fonts from a path
**bundled inside the repo** (relative to `__file__`), not from absolute system
paths like `/usr/share/fonts/...`.

**Why:** the bot deploys on Railway from `python:3.11-slim`, which ships **no
system fonts**. An absolute `/usr/share/fonts/...` path that exists in the Replit
dev container raises `cannot open resource` at runtime in production, silently
breaking image generation while dev looks fine.

**How to apply:** commit the `.ttf` files into the artifact (e.g.
`bot/fonts/`), resolve via `os.path.join(os.path.dirname(__file__), "fonts", ...)`,
and add a `load_default()` fallback so generation never hard-fails. Dockerfile
`COPY . .` ships them automatically — no apt font install needed.
