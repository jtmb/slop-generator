# Git Operations — Orchestrator-Owned Single-Branch Model

All git operations are centralized in the **slop-orchestrator**. Neither planner nor builder perform git actions — they upload content to slop-api, and the orchestrator pushes everything to a single `main` branch at batch boundaries.

---

## Architecture

```mermaid
flowchart LR
    P[slop-planner] -->|POST /api/v1/ideas| A[(slop-api)]
    B[slop-builder] -->|POST /api/v1/projects<br/>upload tar.gz| A
    O[slop-orchestrator] -->|syncApps: GET /api/v1/ideas| A
    O -->|syncProject: GET /api/v1/projects/:slug/download| A
    O -->|git push --force| GH[GitHub<br/>main branch]
```

**Key principle**: The API is the authoritative source — the orchestrator force-pushes to overwrite the remote with the API's current state.

| Service | Writes To | Git Role |
|---------|-----------|----------|
| slop-planner | `POST /api/v1/ideas` (idea .md files) | None |
| slop-builder | `POST /api/v1/projects` (tar.gz upload) | None |
| slop-orchestrator | `scripts/git-push.js` | Sole git owner |

---

## slop-orchestrator: git-push.js

The orchestrator manages a git working directory at `/git-repo` inside its container. At batch boundaries (after 6 iterations), it syncs all content from slop-api and pushes to GitHub.

### Sync Flow

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant A as slop-api
    participant G as GitHub

    O->>O: ensureGitRepo()
    Note over O: init, config user, set remote with token
    O->>A: GET /api/v1/ideas
    A-->>O: List of slugs
    loop For each slug
        O->>A: GET /api/v1/ideas/:slug/raw
        A-->>O: Raw idea .md content
        O->>O: writeFileSync(apps/{slug}.md)
    end
    O->>O: git add apps/
    O->>A: GET /api/v1/projects
    A-->>O: List of uploaded project slugs
    loop For each project
        O->>A: GET /api/v1/projects/:slug/download
        A-->>O: tar.gz binary
        O->>O: extract to projects/{slug}/
    end
    O->>O: git add projects/
    O->>O: git commit -m "..."
    O->>G: git push --force origin main
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GIT_REPO_URL` | — | Remote URL (token injected from GITHUB_TOKEN) |
| `GITHUB_TOKEN` | — | GitHub PAT — injected as `x-access-token` in URL |
| `GIT_USER_NAME` | `Slop Generator` | Commit author |
| `GIT_USER_EMAIL` | `slop-generator@localhost` | Commit author email |
| `GIT_BRANCH` | `main` | Branch to push to |

### Remote URL Format

The orchestrator injects `GITHUB_TOKEN` into the URL automatically if no credentials are present:

```
Before injection: https://github.com/jtmb/app-ideas.git
After injection:  https://x-access-token:ghp_xxxx@github.com/jtmb/app-ideas.git
```

If `GIT_REPO_URL` already contains credentials (e.g., `https://user:token@github.com/...`), no injection is performed.

### Working Directory Structure

```
/git-repo/
├── .git/
├── .gitignore
├── apps/
│   ├── eco-track.md
│   ├── chat-app.md
│   └── skill-swap.md
└── projects/
    ├── eco-track/
    │   ├── plan.md
    │   ├── package.json
    │   ├── src/
    │   └── tests/
    └── chat-app/
        ├── plan.md
        ├── package.json
        ├── src/
        └── tests/
```

### .gitignore Shape (generated at init)

```
# Ignore everything at root by default
/*

# Except generated app ideas
!/apps
!/apps/**

# Except built projects
!/projects
!/projects/**
```

**Why `/*` not `*`**: A bare `*` matches basenames in ALL directories recursively. Using `/*` limits the ignore scope to the repo root, so `!/apps` and `!/apps/**` can un-ignore the directory and its contents correctly.

### Force Push Rationale

The orchestrator uses `git push --force origin main`. This is intentional:

- **API is the authoritative source** — the remote is a mirror, not a collaborative branch
- **No concurrent writers** — only the orchestrator pushes to this repo
- **Clean state each batch** — each push reflects the exact API state at that moment
- **Overwrites manual edits** — prevents drift between API data and git mirror

---

## What Changed (Post-Refactor)

Previously, planner and builder each had their own `git-sync.js` scripts and pushed directly:
- Planner → `main` branch (apps only)
- Builder → `build/{slug}` orphan branches (projects only)

After the refactor:
- Both planner and builder **upload to slop-api** instead of pushing to git
- The orchestrator's `git-push.js` is the **only git script** in the system
- All content lives on a **single `main` branch** — no orphan branches
- Folder structure on main: `apps/{slug}.md` + `projects/{slug}/`

This centralization eliminates race conditions, simplifies auth (one GITHUB_TOKEN instead of two), and ensures the git mirror always reflects the API's complete state.
