---
name: Vehicle label printer safety
description: Durable safety boundary between immutable vehicle passport PDFs, the Windows spooler, and the server printed lifecycle.
---

Vehicle label printing must fail closed unless an exact printer name, approved Telegram chat allowlist, HTTPS API endpoint, 100×80 physical media, and near-full printable area are all verified. Server lifecycle confirmation happens only after the complete multi-page document is accepted by the Windows spooler.

**Why:** Printer dispatch is an external side effect with an unavoidable crash window. Default-printer fallback, process-local locks, or confirming before spool completion can print the wrong media, duplicate passports, or advance lifecycle without labels. Re-rendered PDF metadata can also drift even when visible barcode content is unchanged.

**How to apply:** Keep one durable active-job claim per handoff across processes. A known spool receipt may resume API confirmation without printing; an ambiguous crash requires an explicit operator choice to confirm physically verified output or retry the full set. Reprints use persisted passport fields and deterministic PDF bytes, never new barcode identity. Allow at most 2 mm total driver margin (minimum 98×78 mm printable area) on the 100×80 profile.