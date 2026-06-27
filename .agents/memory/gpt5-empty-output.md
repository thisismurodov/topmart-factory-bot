---
name: gpt-5 empty completion output
description: Why gpt-5 / gpt-5-mini chat completions return empty content and how to fix it.
---

# gpt-5 reasoning models return empty content on small token budgets

gpt-5 family models (incl. gpt-5-mini) spend `max_completion_tokens` on internal
*reasoning* tokens BEFORE producing visible content. With a small budget (e.g. 300)
the reasoning can consume the entire allowance, leaving `choices[0].message.content`
an empty string — the call succeeds (HTTP 200) but returns "".

**Fix:** for short outputs set `reasoning_effort: "minimal"` AND give a generous
`max_completion_tokens` (e.g. 600+). For longer outputs (e.g. the daily analysis at
~2000 tokens) the larger budget alone left enough room after reasoning.

**Why:** observed live — the per-packer tip endpoint (gpt-5-mini, 300 tokens) returned
`{"tip":""}` until both changes were applied.

**How to apply:** any new gpt-5* chat.completions call that returns blank content —
raise the token budget and/or lower reasoning_effort before assuming a prompt/auth bug.
Note: gpt-5* use `max_completion_tokens` (not `max_tokens`) and reject custom `temperature`.
