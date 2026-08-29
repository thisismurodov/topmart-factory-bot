---
name: OpenAPI strict responses & codegen
description: How to add a response field end-to-end (spec -> codegen -> service -> UI) in this monorepo.
---

Response schemas in lib/api-spec/openapi.yaml are strict (`additionalProperties: false` + full `required` lists). Routers zod-parse responses, so a field the mapper emits but the spec omits gets stripped (or fails strict), and a `required` field the SQL forgets to select fails serialization.

**Why:** sourceWarehouseName was added for the "Manba: Ombor #22" confusion (id 22 IS C-16 — raw ids mislead users); the field only reached the dashboard after spec + codegen + every mapper site emitted it.

**How to apply:** 1) edit openapi.yaml (add to properties AND required); 2) `pnpm --filter @workspace/api-spec run codegen` (regenerates lib/api-zod + lib/api-client-react, then typechecks libs); 3) make EVERY SQL site feeding the mapper select the column (scalar subqueries are valid in RETURNING and alongside FOR UPDATE — probe-tested); 4) dashboards show warehouse/entity NAMES, raw #id only as fallback.
