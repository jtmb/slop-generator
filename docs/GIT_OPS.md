# Git Operations

How git is used across the three slop-generator microservices. Two distinct strategies serve different purposes.

---

## Strategy Overview

```mermaid
graph LR
    subgraph Planner
        P[slop-planner] -->|git-sync.js --once| M[main branch]
        M --> T1[apps/*.md]
    end
    subgraph Builder
        B[slop-builder] -->|git-sync.js --once --slug| O1[build/slug-a]
        B -->|git-sync.js --once --slug| O2[build/slug-b]
        O1 --> T2[projects/slug-a/]
        O2 --> T3[projects/slug-b/]
    end
    M --> R[(Remote Repo)]
    O1 --> R
    O2 --> R
```

| Service | Script | Branch | What's Tracked | Push Trigger |
|---------|--------|--------|----------------|--------------|
| slop-planner | `scripts/git-sync.js` | `main` (configurable) | `apps/*.md` | After each iteration |
| slop-builder | `scripts/git-sync.js` | `build/{slug}` (per-project) | `projects/{slug}/` | After tests pass |

These are **completely independent** — each service has its own git repo, remote, and credentials. They don't share history or state.

---

## slop-planner Git Strategy

### Design

Flat branch (`main` by default). All generated app idea files live in `apps/`. Each sync pushes the latest state — a growing collection of `.md` files.

### Modes

**One-shot only** (called by `agent-runner.js` after each completed iteration):

```bash
node scripts/git-sync.js --once
```

Runs one sync cycle: check for changes, stage, commit, push, exit. Pushes immediately — each iteration commits and pushes independently to `main` as soon as it finishes.

### What happens on first run

1. `git init -b main` initializes the repo
2. Sets `user.name` and `user.email` from env vars
3. Writes a `.gitignore` at repo root that tracks ONLY `apps/` (and optionally `db.md`)
4. Creates an initial commit: `Initial commit: app ideas repository`

### What happens each sync cycle

1. `git status --porcelain` — skip if no changes
2. `git add -A` — stage everything (`.gitignore` controls what's tracked)
3. `git commit -m "Sync app ideas — 2026-06-27"` — dated commit message
4. `git push -u origin main` — skip if `GIT_REPO_URL` is empty

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GIT_REPO_URL` | — | Remote URL with embedded auth. Leave empty for local-only commits. |
| `GIT_BRANCH` | `main` | Branch to push to |
| `GIT_USER_NAME` | `Slop Generator` | Commit author |
| `GIT_USER_EMAIL` | `slop-generator@localhost` | Commit author email |
| `GIT_SYNC_DB` | `false` | Set `true` to also track `db.md` |

### Remote URL Format

```
https://<username>:<token>@github.com/<owner>/<repo>.git
```

Example with a GitHub personal access token:

```
GIT_REPO_URL=https://jtmb:ghp_xxxxxxxxxxxx@github.com/jtmb/app-ideas.git
```

### .gitignore Shape (in-repo, generated at runtime)

```
# Ignore everything at root by default
/*

# Except generated app ideas
!/apps
!/apps/**

# Optionally track the idea database
!/db.md
```

**Why `/*` not `*`**: A bare `*` matches basenames in ALL directories recursively — it would
ignore files inside `apps/` even with `!/apps/` in the gitignore. Using `/*` limits the
ignore scope to the repo root, so `!/apps` and `!/apps/**` can un-ignore the directory
and its contents correctly.

---

## slop-builder Git Strategy

### Design

**Per-project orphan branches.** Each built app gets its own isolated branch: `build/{slug}`. No shared history between projects — each branch starts from scratch.

This means:
- Force-pushing one project never affects another
- Branches can be deleted independently after review
- Clean separation: one branch = one complete app

### Mode

**One-shot only** (called by `agent-runner.js` after tests pass):

```bash
node scripts/git-sync.js --once --slug eco-track --message "feat(build): complete EcoTrack"
```

Three required CLI args:

| Arg | Required | Example | Purpose |
|-----|----------|---------|---------|
| `--once` | yes | — | One-shot mode flag |
| `--slug` | yes | `eco-track` | Project directory name inside `projects/` |
| `--message` | no | `feat(build): complete EcoTrack` | Commit message (default: generic) |

### What happens each push

1. **Prep repo** — `git init` if needed, set `user.name`/`user.email`
2. **Create/switch to orphan branch** — `git checkout --orphan build/{slug}`
3. **If branch exists** — switch to it, wipe all tracked files (`git rm -rf .`)
   (skipped for new orphan branches — working tree already has project files)
4. **.gitignore** — writes one that ignores everything at root, then un-ignores
   `projects/` directory and the specific project subdirectory
5. **Stage + commit** — `git add -A && git commit -m "..."` with the project files
6. **Force push** — `git push -f origin build/{slug}`

### Why orphan branches?

```mermaid
gitGraph
    commit id: "initial commit"
    branch build/eco-track
    checkout build/eco-track
    commit id: "EcoTrack project"
    checkout main
    branch build/chat-app
    checkout build/chat-app
    commit id: "ChatApp project"
    checkout main
```

Each `build/{slug}` branch has exactly one commit: the completed project. No merge conflicts, no shared history, no rebase needed.

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GIT_REPO_URL` | — | Remote URL with embedded auth. Builder exits cleanly if empty. |
| `GIT_USER_NAME` | `Slop Builder` | Commit author |
| `GIT_USER_EMAIL` | `slop-generator@localhost` | Commit author email |

### .gitignore Shape (in-repo, generated per push)

```
# Ignore everything at root
/*

# Unignore the projects directory so specific projects can be tracked
!/projects

# Track only this project
!/projects/eco-track
!/projects/eco-track/**
```

**Why three negation patterns**: `/*` ignores the `projects/` directory at the root.
Git won't traverse into ignored directories to evaluate negation patterns — so
`!/projects` must appear before `!/projects/{slug}` to un-ignore the parent.
Each push rewrites `.gitignore` to track exactly one project. The next push for
a different slug rewrites it again.

---

## Git Repo Structure (example)

```
Remote: github.com/jtmb/slop-output.git

Branches:
  main                          ← planner pushes here
  build/eco-track               ← builder pushes here (orphan)
  build/chat-app                ← builder pushes here (orphan)
  build/skill-swap              ← builder pushes here (orphan)

main tree:
  apps/
    eco-track.md
    chat-app.md
    skill-swap.md

build/eco-track tree:
  projects/
    eco-track/
      plan.md
      package.json
      src/
      tests/
      README.md

build/chat-app tree:
  projects/
    chat-app/
      plan.md
      package.json
      src/
      ...
```

The planner and builder can push to the **same remote repo** using different branches — they never conflict.

---

## Common Configuration

Both services share these conventions:

### Remote Auth

Always use embedded credentials in the URL. Never store tokens in config files:

```
✅ GIT_REPO_URL=https://user:ghp_token@github.com/owner/repo.git
❌ GIT_REPO_URL=https://github.com/owner/repo.git + separate GIT_TOKEN
```

### Commit Messages

- **Planner**: `Sync app ideas — YYYY-MM-DD` (dated, batch commits)
- **Builder**: `feat(build): complete {App Name}` (Conventional Commits, per-project)

### No Git in Docker Images

Neither Dockerfile installs git credentials. The remote URL is injected at runtime via environment variables — no secrets in image layers.

### Error Handling

- **No remote configured** (`GIT_REPO_URL` empty): script exits 0 with a log message. Commit saved locally.
- **Push fails** (network, auth, permissions): planner logs the error and retries on the next iteration. Builder marks the project `Built (push failed)` in its db.md.
- **No changes to commit**: planner skips silently. Builder returns early (already up to date).

---

## Running Locally (without Docker)

```bash
# Planner git sync (one-shot)
cd slop-planner
GIT_REPO_URL="https://user:token@github.com/owner/repo.git" \
  node scripts/git-sync.js --once

# Builder git sync (one-shot, per project)
cd slop-builder
GIT_REPO_URL="https://user:token@github.com/owner/repo.git" \
  node scripts/git-sync.js --once --slug eco-track --message "feat(build): complete EcoTrack"
```

Both scripts work outside Docker — they read `GIT_REPO_URL` from the environment and operate on the current working directory.
