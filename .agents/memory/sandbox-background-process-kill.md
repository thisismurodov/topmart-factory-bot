---
name: Sandbox kills bash background processes
description: Long-running commands (vitest, etc.) started in the bash tool die when the tool call ends — run them via workflows instead.
---

Rule: never start a long-running command (multi-minute vitest run, server, script) as a background process from the bash tool and expect it to survive.

**Why:** The sandbox kills all processes spawned by a bash tool call when that call ends — `setsid`, `nohup`, `disown`, and output redirection do NOT save them (cgroup-level kill). Symptoms: no exit-marker file, log frozen mid-run, no surviving process. Worse, `pgrep -f` checks can false-positive on the checking `bash -c` command itself, making a dead run look alive.

**How to apply:** For anything longer than the 120s bash timeout, use a registered workflow (`restart_workflow`, then poll its log file under /tmp/logs/ with sleep+grep across separate bash calls), or let a `mark_task_complete` validation step be the run. Killed mid-run test processes can also leak throwaway DBs — drop orphans only when they have no active connections.
