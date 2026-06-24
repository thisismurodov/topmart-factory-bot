---
name: Dashboard base path & static asset URLs
description: Why static public files (manifest, etc.) need hardcoded base-path URLs while index.html refs don't.
---

# Dashboard runs under base path `/dashboard/` (dev AND prod)

The dashboard artifact sets `BASE_PATH=/dashboard/` (artifact.toml `previewPath`
+ Vite `base`). It is NOT served at root in either environment, so the proxy root
`localhost:80/` returns 502 — use `localhost:80/dashboard/...` to test.

# Vite rewrites index.html asset refs, but NOT static file contents

Root-relative URLs in `index.html` (e.g. `<link href="/manifest.webmanifest">`,
`/apple-touch-icon.png`) are auto-rebased to `/dashboard/...` by Vite at build/serve
time — so write them as `/foo`, not `/dashboard/foo`, in index.html.

**But** files living in `public/` are served verbatim — Vite does NOT rewrite URLs
*inside* them. So `manifest.webmanifest` must hardcode the base: `start_url`,
`scope`, and every icon `src` need the `/dashboard/` prefix, or an installed PWA
launches at the wrong URL and shows broken icons.

**Why:** a PWA manifest with `start_url: "/"` opened the proxy root (502) and its
`/icon-192.png` 404'd, because the public file was served as-is.
**How to apply:** any new file placed in `public/` that references other assets by
absolute path must include the `/dashboard/` base; index.html refs must not.
