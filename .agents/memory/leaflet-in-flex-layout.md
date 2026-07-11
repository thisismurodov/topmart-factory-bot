---
name: Leaflet map in flex layouts
description: Blank Leaflet map causes — missing CSS import and min-h vs h parent height
---

# Leaflet map renders blank — two causes

1. `leaflet/dist/leaflet.css` must be imported in the JS entry (e.g. `main.tsx`), not via CDN `<link>` in index.html (CDN link breaks under the proxied preview / offline).
2. The map container needs a **definite** height chain: a parent with `min-h-[100dvh]` gives children `h-full` → 0px height. Use `h-[100dvh]` (fixed height) on the layout root so `h-full` resolves.

**Why:** map appeared completely blank with markers "loaded" — both causes had to be fixed; hard to diagnose because no console errors.
**How to apply:** any react-leaflet app inside flex/full-screen layouts.
