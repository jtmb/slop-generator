---
description: "Rules for proactively removing unused files, dead code, stale imports, and orphaned dependencies. No dead code left behind."
applyTo: "**"
---

# Clean Up Dead Code — Mandatory

Every refactor, feature change, or restructure MUST include a cleanup pass. Dead code and orphaned files are technical debt that compounds silently.

## Core Principle

> If it's not used, delete it. Don't "leave it for later" or "keep it just in case."

Dead code harms the project by:
- Confusing new developers (is this used somewhere?)
- Wasting build time and container size
- Creating false signals in search results
- Accumulating until cleanup becomes a painful project

## What Counts as Dead Code

| Category | Examples |
|---|---|
| **Orphaned files** | Modules no longer imported anywhere |
| **Stale scripts** | Utility scripts replaced by a different approach |
| **Commented-out code** | Block comments in lieu of version control |
| **Unused exports** | Functions, classes, constants never imported outside their module |
| **Unused dependencies** | Packages in `package.json` no longer imported in source |
| **Legacy wrappers** | Adapters superseded by direct usage or a different library |
| **Backup/template files** | `.bak`, `.orig`, `.template` files left in source tree |
| **Orphaned configs** | Config files for tools no longer used |

## When to Clean

1. **After every refactor** — if you changed how something works, check if the old approach's files are still needed
2. **When changing architecture** — e.g., migrating from direct HTTP calls to a CLI wrapper: delete the old HTTP client module
3. **When renaming or restructuring directories** — verify no files were left behind at the old location
4. **When a new approach replaces an old one** — the old approach's files must be deleted in the same PR/commit
5. **Before claiming task completion** — run a final check for any files that became unreferenced

## Cleanup Checklist

Before marking a task complete, verify:

- [ ] Every file in the change set is actually used
- [ ] No `.bak`, `.orig`, `.template`, or `.old` files remain
- [ ] No commented-out code blocks (use git history instead)
- [ ] `package.json` dependencies match actual imports
- [ ] No orphaned utility/helper modules
- [ ] Directory listings are clean — no stale files polluting `ls` output
- [ ] Dockerfile `COPY` instructions don't include dead files
- [ ] Documentation (`docs/`) reflects only what exists

## How to Find Dead Code

### Finding orphaned files
```bash
# Check if a file is imported anywhere
grep -r "from '\.\./path/to/file'" src/    # Named imports
grep -r "require('\.\./path/to/file')" src/  # CommonJS
grep -r "import '\.\./path/to/file'" src/   # Side-effect imports
```

### Finding unused npm dependencies
```bash
# Check which packages are actually imported
grep -rh "from '" src/ | sort -u
# Or use a dedicated tool
npx depcheck
```

### Finding dead exports
```bash
# Search for the export name across the codebase
grep -r "functionName" src/ --include="*.js" --include="*.ts"
# If only found in its own definition file, it's dead
```

## Exceptions

These are NOT dead code and should NOT be deleted:

- **Configuration files** referenced by the framework (e.g., `tsconfig.json`, `eslint.config.js`) even if no source file explicitly imports them
- **Entry point files** (`index.js`, `main.js`, `agent-runner.js`) called by npm scripts, Docker CMD, or CLI invocation
- **Public API surface** files that are the intended export boundary of a package, even if no internal code imports them
- **Documentation** in `docs/` — covered by the docs sync rule in AGENTS.md, not cleanup

## Enforcement

This rule applies across all file types — JavaScript, TypeScript, Python, Go, Rust, shell scripts, config files, Dockerfiles, and documentation. When in doubt, delete it. You can always restore from git history.
