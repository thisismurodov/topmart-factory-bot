---
name: xyflow canvas testing & layout
description: Testing @xyflow/react edge clicks with Playwright and preventing canvas height collapse in flex layouts
---

## E2E edge clicks: target the LABEL chip, not the line
Playwright "click the edge path" fails: it aims at the path's bounding-box CENTER, which is off-stroke for bezier/smoothstep edges (the mis-click lands on whatever is underneath). The reliable click target is the edge LABEL chip — it is part of the edge DOM and fires `onEdgeClick`.
**Why:** two e2e rounds failed on direct edge clicks while the handler was correctly wired; the label-chip click passed immediately.
**How to apply:** in flow-map test plans, instruct testers to click the white label chip mid-line. Keep edge labels always visible. `interactionWidth` (~32) only helps human pointer clicks along the stroke.

## Canvas height-0 on narrow screens (React Flow error #004)
A `flex-1 min-h-0` canvas collapses to 0 height when the toolbar wraps into many rows on narrow screens (dashboard shell leaves ~146px width at 402px viewport — sidebar w-64 is global and out of page scope).
**Why:** at 402×874 the toolbar consumed all vertical space; the React Flow wrapper measured 146×0 and refused to render.
**How to apply:** give the canvas div `min-h-[360px] md:min-h-0` and the page root `overflow-y-auto`. Same disease family as leaflet-in-flex-layout.md (h-full chain collapse), different trigger (sibling growth).
