---
name: Dashboard TSX unit tests
description: Constraints for rendering isolated dashboard TSX components in the pure Node Vitest setup.
---

Dashboard unit tests run without the dashboard's Vite plugins, so a TSX component imported directly by a test should avoid `@/` aliases and explicitly import React.

**Why:** The pure Node Vitest configuration does not resolve the app alias or apply the Vite React JSX transform. A component can work in the browser yet fail only in unit tests with an unresolved alias or `React is not defined`.

**How to apply:** Keep render-only components under test isolated from page-level dependencies, use relative imports inside them, and add an explicit React import when the test renders their JSX.