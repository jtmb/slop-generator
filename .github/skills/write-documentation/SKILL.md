---
name: docs
description: "Generate and write project documentation: READMEs, ARCHITECTURE.md, TECH-STACK.md, CONVENTIONS.md, API docs, and ADRs. Use after project scaffolding, building features, or when docs are stale."
argument-hint: "What to document (all, readme, architecture, tech-stack, conventions, api, adr)"
---

# Project Documentation

Good documentation is the difference between a project that's used and one that's abandoned. It answers "what is this?", "how do I use it?", and "why was it built this way?"

This skill covers two workflows:

1. **Generating docs** — populate `docs/` templates from existing code (ARCHITECTURE.md, TECH-STACK.md, CONVENTIONS.md VARIABLES.md)
2. **Writing docs** — craft new documentation from scratch (README, API docs, ADRs)

## Before You Start

1. Read `docs/README.md` to understand the docs structure
2. Read `AGENTS.md` for core conventions
3. Scan the project's source code, config files, and package manifests
4. Run the project (if applicable) — don't document what you haven't seen work
5. Check `.clinerules/instructions/` for framework-specific conventions that should be referenced

---

## A. Generating Docs from Templates

Use this when `docs/` contains templates with `<!-- TODO -->` placeholders. The user specifies which docs to generate; if they don't, generate all of them.

### ARCHITECTURE.md

- Scan the directory tree for the project structure
- Identify key modules, services, and their responsibilities
- Trace data flow through the codebase
- Document external dependencies and deployment patterns

### TECH-STACK.md

- Read `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, etc.
- List all major dependencies with versions
- For each key dependency, explain what it does and why it's used
- Document development tools (linters, formatters, test frameworks)

### CONVENTIONS.md

- Observe naming patterns across the codebase
- Identify file organization conventions
- Note error handling patterns
- Document git and PR conventions if `.github/` or contributing docs exist

### Output Format for Generated Docs

For each doc generated:

1. Replace `<!-- TODO -->` comments with real content
2. Keep the existing section structure
3. Add code examples where they clarify conventions
4. Mark anything you're uncertain about with `<!-- UNCERTAIN: reason -->`

After generation, update `docs/README.md` if you added or modified any doc entries.

---

## B. Writing Docs from Scratch

### README.md

A good README answers these questions in order:

```markdown
# Project Name
One-line description of what this does and who it's for.

## Quick Start
The fastest path to a working setup. Goal: under 5 minutes.

## Usage
Common workflows with copy-pasteable examples.

## Configuration
Environment variables, config files, feature flags.

## Development
How to set up a dev environment, run tests, contribute.

## Architecture
High-level overview — link to docs/ARCHITECTURE.md for details.

## License
```

- **Write for someone who just found your repo**: they have 30 seconds to decide if it's relevant
- **Copy-pasteable examples**: every code block should be runnable as-is (or with minimal substitution)
- **No badges in the first screenful**: they push actual content below the fold
- **Keep it current**: outdated Quick Start is worse than no Quick Start

### API Documentation

For every endpoint:

```markdown
### GET /api/v1/users/:id

Returns a single user by ID.

**Path Parameters**
| Name | Type | Description |
|------|------|-------------|
| id   | UUID | User ID |

**Query Parameters**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| include | string | — | Comma-separated relations to include (posts, settings) |

**Response (200)**
```json
{
  "id": "uuid",
  "email": "string",
  "name": "string",
  "createdAt": "ISO 8601 datetime"
}
```

**Errors**
| Code | Description |
|------|-------------|
| 404  | User not found |
| 401  | Missing authentication |
```

- **Document every status code the endpoint can return**
- **Show example request AND response** — curl command + JSON body
- **Note auth requirements, rate limits, and idempotency support**

### Architecture Decision Records (ADRs)

For significant technical decisions, create `docs/adr/NNNN-title.md`:

```markdown
# ADR-0001: Use PostgreSQL as Primary Database

**Status**: Accepted (2026-06-18)

**Context**: We need a relational database for the core data model...

**Decision**: Use PostgreSQL 16.

**Alternatives Considered**:
- MySQL 8: rejected due to weaker JSON support and less mature full-text search
- SQLite: rejected due to lack of concurrent write support at scale

**Consequences**:
- Positive: Strong type system, excellent JSON support, mature ecosystem
- Negative: Operational complexity higher than SQLite; team needs Postgres expertise
```

- **ADRs explain "why," not "what"** — the code already shows what
- **Every ADR lists rejected alternatives** with reasons
- **Status**: Proposed → Accepted → Deprecated → Superseded (with reference to the new ADR)
- **File naming**: `adr/NNNN-lowercase-title-with-hyphens.md`. Sequential numbering.

---

## C. Style Guide

- **Active voice**: "The handler returns a 404" not "A 404 is returned by the handler"
- **Present tense**: "Validates the input" not "Will validate the input"
- **You/your**: address the reader directly. "Set your API key" not "The API key should be set"
- **Oxford comma**: "installs dependencies, sets up the database, and starts the server"
- **Code spans for symbols**: `UserService`, `GET /api/users`, `config.timeout`
- **Code blocks for commands**: triple-backtick with language tag
- **One sentence per line** in markdown source: makes diffs readable

## D. Keep Docs Current

The most harmful docs are stale docs — they actively mislead. After writing documentation:

- Add a "Last updated" date if not auto-generated
- Link to the source of truth (OpenAPI spec → generated docs, not hand-written API docs)
- If a doc is outdated and you can't fix it now, add `<!-- OUTDATED: reason, YYYY-MM-DD -->` at the top
