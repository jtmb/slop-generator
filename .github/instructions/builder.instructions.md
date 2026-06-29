---
description: "Use when working on slop-builder agent-runner.js or when Cline builds projects. Covers posix_spawn limitations, hub daemon cleanup, single-task prompts, inline context, and file creation workarounds."
applyTo: "slop-builder/**"
---

# Builder Agent — Cline Interaction Rules

These rules cover Cline CLI integration in the slop-builder service. Every Cline call must follow these patterns — deviations cause hallucination, timeouts, or broken builds.

---

## posix_spawn Limitations — CRITICAL

Cline uses `spawnSync('cline', args)` which delegates to `posix_spawn`. This means **NO shell syntax is available**. Commands are executed as a single binary name with a flat array of arguments.

### ✅ WORKING Commands

```bash
# File creation (single line)
echo 'content' > file.js

# File creation (multi-line via Node.js)
node -e "require('fs').writeFileSync('path.js', 'code')"

# Directory creation
mkdir -p src/features/auth
mkdir -p project/src

# Simple commands
ls
cat file.md
```

### ❌ BROKEN Commands (will fail with ENOENT)

```bash
# Pipes — NEVER use
echo "text" | sort

# Shell redirect chains
echo "text" > file && echo "more" >> file

# Command chaining
mkdir -p dir && cd dir && npm init

# sed substitutions
sed -i 's/old/new/g' file

# Here-documents
cat << EOF > file
content
EOF

# The 'editor' tool — NEVER use

# ANY shell built-in that requires /bin/sh
source env.sh
```

### File Creation Patterns

**Preferred** (works reliably):
```bash
node -e "require('fs').writeFileSync('src/index.ts', 'import express from ...')"
```

**Fallback** (single-line content only):
```bash
echo 'line' > file.txt
```

**For multi-file creation**: Use separate `node -e` calls — one per file.

---

## Hub Daemon Cleanup — CRITICAL

The Cline hub daemon survives across `spawnSync` calls. After ~4 successful calls, stale daemon processes reject hooks from new Cline instances with:

```
hook dispatch failed: session.hook requires a valid hook event payload
```

This causes 5-minute timeouts. **Before every Cline call**, the agent-runner runs `killHubDaemons()` which:
1. Reads `/proc/*/cmdline`
2. Finds processes matching `hub-daemon`
3. SIGKILLs them

**Do NOT assume a clean hub daemon state between Cline calls.** The JS runner handles this automatically — you don't need to worry about it during builds.

---

## Single-Task Prompts — Mandatory

Send **ONE simple task per Cline call**. The JS agent-runner manages progress by parsing plan.md checkboxes and calling Cline sequentially.

### ✅ Good Prompt Pattern

```
Create the project scaffolding for {app}. Initialize a React app with Vite, 
set up TypeScript strict mode, and create the directory structure:

Project directory: /app/projects/{slug}
The project uses React + Vite + TypeScript.

Write these files using node -e:
1. package.json with dependencies
2. tsconfig.json with strict mode
3. vite.config.ts
4. src/index.html
5. src/App.tsx with a basic "Hello World" component
```

### ❌ Bad Prompt Pattern

```
Read plan.md, AGENTS.md, and all .clinerules/instructions/ files. Then plan the full 
application architecture. Then implement Phase 1, test it, implement Phase 2...

[Too many instructions — Cline will hallucinate "DONE" without any tool calls.]
```

---

## Inline Context — Mandatory

Embed all necessary context **directly in the prompt**. Do NOT ask Cline to read files — it times out on files >100 lines.

### Context the prompt MUST include:

- **Framework Decision**: "This project uses Next.js 14 + TypeScript + Prisma + SQLite"
- **File type hint**: "Create TypeScript files" or "Write JSX components"
- **Project structure**: "Files go in /app/projects/{slug}/ with src/ and tests/ directories"
- **Relevant rules**: "Follow TypeScript strict mode and container best practices"

### What the prompt MUST NOT include:

- "Read AGENTS.md" — causes 30s+ timeout
- "Read plan.md" — can be 200+ lines, causes 5min timeout
- "Read .clinerules/instructions/" — unnecessary, files are embedded in the prompt
- "Open the editor tool" — editor tool doesn't work

---

## JS-Side Task Management

The agent-runner handles all task orchestration in JavaScript. Cline only executes individual tasks:

1. `parseNextUncheckedTask(planPath)` — reads plan.md, finds first `- [ ]` item, returns task text + phase heading
2. `buildSimpleTaskPrompt(slug, projectDir, planPath, taskInfo)` — builds a single-task prompt with inline context
3. `runCline(prompt)` — calls `killHubDaemons()` then `spawnSync('cline', args)` with 960s timeout
4. `markTaskDone(planPath, lineNumber)` — changes `- [ ]` to `- [x]` in plan.md

**Build limits**: `maxBuildCalls = 25` (main loop), `maxReconcileBuildCalls = 20` (recovery loop).

---

## Project Upload → Git Sync

After tests pass and the project is uploaded to slop-api, the agent-runner triggers an immediate git sync:

1. `uploadProject(slug)` — Creates a tar.gz of the project directory, POSTs as multipart to `/api/v1/projects` on slop-api
2. `triggerGitSync()` — Calls `POST /git-sync-projects` on the orchestrator, which:
   - Downloads the tar.gz from slop-api
   - Extracts to `/git-repo/projects/{slug}/`
   - Removes any nested `.git` directories left by Cline
   - Commits and pushes to GitHub via `git push --force-with-lease`

**Git sync is turn-independent** — it works regardless of whose turn it is in the orchestrator batch cycle. Each completed project is synced to GitHub immediately.

**Cline does NOT perform git operations itself.** The agent-runner handles git sync via the orchestrator after the build is complete.

---

## Orchestrator `/git-sync-projects` Endpoint

The orchestrator exposes `POST /git-sync-projects` which calls `syncAllProjects()` directly, pulling any projects from the API that haven't yet been synced to the git repo. This bypasses the batch-turn cycle for immediate syncs.

Used by:
- `reconcileProjectsDir()` — after reconciliation completes a project upload
- `main()` loop — after each iteration's upload succeeds

## Summary Checklist

Before every Cline call, verify:
- [ ] Prompt contains ONE simple task (not a multi-phase plan)
- [ ] Prompt includes framework choice and file type inline
- [ ] Prompt does NOT ask Cline to read files
- [ ] Prompt uses `node -e` or `echo >` for file creation
- [ ] Prompt forbids `sed`, pipes, editor tool
- [ ] `killHubDaemons()` has been called (handled by agent-runner)
