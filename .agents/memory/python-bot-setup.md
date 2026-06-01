---
name: Python bot setup on Replit
description: How to install Python and pip packages in this workspace for a Telegram bot project.
---

## Rule
Python is not pre-installed in this Node.js-first workspace. Always install the language module before installing pip packages.

**Why:** The workspace is a pnpm/Node.js monorepo. `pip` is not on PATH until a Python module is installed via `installProgrammingLanguage`.

**How to apply:**
1. `installProgrammingLanguage({ language: "python-3.11" })` — installs interpreter + pip
2. `installLanguagePackages({ language: "python", packages: [...], dependencyFile: "..." })` — uses uv, lands in `.pythonlibs/`
3. Workflow command: `cd artifacts/<slug> && python3 main.py`
4. No virtualenv needed — `.pythonlibs/` is auto-activated in the Replit environment.
