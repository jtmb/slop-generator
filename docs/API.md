# API Documentation

The Slop Generator API serves app ideas from the idea database (`db.md`) and their full markdown files (`apps/*.md`) as structured JSON over HTTPS with JWT authentication.

- **Base URL**: `https://localhost:3443`
- **Protocol**: HTTPS (self-signed certificate, use `-k` or `--insecure` with curl)
- **Auth**: JWT bearer token obtained via API key exchange

---

## Authentication

```mermaid
sequenceDiagram
    participant C as Client
    participant A as slop-api

    C->>A: POST /api/v1/auth/token<br/>{ api_key }
    A-->>C: { token, expiresIn }

    C->>A: GET /api/v1/ideas<br/>Authorization: Bearer token
    A-->>C: { count, ideas[] }
```

### Get a Token

Exchange your pre-shared API key for a signed JWT.

```
POST /api/v1/auth/token
Content-Type: application/json

{ "api_key": "your-api-key" }
```

**Success (200)**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "1h"
}
```

**Error (400)** — missing API key:
```json
{
  "error": { "code": "MISSING_API_KEY", "message": "Request body must include api_key" }
}
```

**Error (401)** — wrong API key:
```json
{
  "error": { "code": "INVALID_API_KEY", "message": "The provided API key is invalid" }
}
```

### Use the Token

Include the token in the `Authorization` header for protected endpoints:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## Endpoints

### GET /health

Health check. No authentication required.

```bash
curl -k https://localhost:3443/health
```

**Response (200)**:
```json
{
  "status": "ok",
  "timestamp": "2026-06-27T12:00:00.000Z"
}
```

---

### GET /api/v1/ideas

List all ideas (summary metadata from `db.md` only — no app file content).

```bash
TOKEN="eyJ..."  # from /api/v1/auth/token
curl -k https://localhost:3443/api/v1/ideas \
  -H "Authorization: Bearer $TOKEN"
```

**Response (200)**:
```json
{
  "count": 18,
  "ideas": [
    {
      "id": 1,
      "name": "EcoTrack",
      "filePath": "apps/eco-track.md",
      "slug": "eco-track",
      "category": "Sustainability / Productivity",
      "status": "Idea Generated",
      "dateAdded": "2026-06-27"
    },
    {
      "id": 3,
      "name": "SkillSwap Connect",
      "filePath": "apps/skill-swap-connect.md",
      "slug": "skill-swap-connect",
      "category": "Education / Social Networking",
      "status": "Idea Generated",
      "dateAdded": "2026-06-27"
    }
  ]
}
```

---

### GET /api/v1/ideas/random

Get a random full idea — picks one entry from `db.md` and reads the corresponding app `.md` file.

```bash
TOKEN="eyJ..."
curl -k https://localhost:3443/api/v1/ideas/random \
  -H "Authorization: Bearer $TOKEN"
```

**Response (200)**:
```json
{
  "id": 1,
  "name": "EcoTrack",
  "filePath": "apps/eco-track.md",
  "slug": "eco-track",
  "category": "Sustainability / Productivity",
  "status": "Idea Generated",
  "dateAdded": "2026-06-27",
  "details": {
    "name": "EcoTrack",
    "slug": "eco-track",
    "overview": "EcoTrack is a comprehensive carbon footprint tracking application...",
    "problemSolved": "Many people want to live more sustainably but lack...",
    "targetAudience": [
      "Environmentally conscious individuals aged 18-45",
      "Families looking to reduce their household impact"
    ],
    "keyFeatures": [
      { "title": "Activity Logging", "description": "Easy-to-use interface for logging..." },
      { "title": "Personal Dashboard", "description": "Visual charts and graphs..." }
    ],
    "monetization": [
      "Freemium Model: Free basic tracking; Premium ($4.99/month)...",
      "Corporate Partnerships: B2B SaaS for companies..."
    ],
    "techStack": {
      "frontend": "React Native (cross-platform mobile app) or Flutter",
      "backend": "Node.js with Express or Python FastAPI",
      "database": "PostgreSQL (relational data) + Redis (caching/leaderboards)"
    },
    "implementationPlan": "See `apps/eco-track-plan.md` for detailed implementation roadmap.",
    "progress": {
      "idea_generated": true,
      "plan_created": false,
      "development_started": false,
      "mvp_complete": false,
      "launched": false
    }
  }
}
```

---

### GET /api/v1/ideas/:slug

Get a specific idea by its slug (kebab-case filename without `.md`).

```bash
TOKEN="eyJ..."
curl -k https://localhost:3443/api/v1/ideas/eco-track \
  -H "Authorization: Bearer $TOKEN"
```

**Response (200)**: Same shape as `/ideas/random` but deterministic.

**Error (404)**:
```json
{
  "error": { "code": "NOT_FOUND", "message": "No idea found with slug \"nonexistent\"" }
}
```

---

### POST /api/v1/ideas

Ingest a new idea into the API's own data store. Used by slop-planner to push generated ideas.

```bash
TOKEN="eyJ..."
curl -k https://localhost:3443/api/v1/ideas \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "EcoTrack",
    "slug": "eco-track",
    "category": "Sustainability",
    "description": "Carbon footprint tracking app",
    "features": ["Activity Logging", "Dashboard"],
    "techSuggestions": ["nextjs", "prisma"],
    "audience": "Environmentally conscious",
    "complexity": "medium"
  }'
```

**Success (201)**:
```json
{
  "slug": "eco-track",
  "name": "EcoTrack",
  "status": "created"
}
```

**Error (409)** — duplicate slug:
```json
{
  "error": { "code": "DUPLICATE_SLUG", "message": "Idea with slug \"eco-track\" already exists" }
}
```

---

### GET /api/v1/projects

List all completed projects from `projects-db.md`.

```bash
TOKEN="eyJ..."
curl -k https://localhost:3443/api/v1/projects \
  -H "Authorization: Bearer $TOKEN"
```

**Response (200)**:
```json
{
  "count": 7,
  "projects": [
    {
      "id": 1,
      "name": "MyApp",
      "slug": "my-app",
      "status": "Complete",
      "dateCompleted": "2026-06-29"
    }
  ]
}
```

**Status values**: Projects have status `"Complete"` (all tests passed) or `"Complete (tests failed)"` (uploaded but tests failed). Only `"Complete"` projects count toward the orchestrator's catch-up ratio.

---

### POST /api/v1/projects

Upload a completed project as a multipart tar.gz archive. Used by slop-builder after a successful build.

```bash
TOKEN="eyJ..."
curl -k https://localhost:3443/api/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -F "slug=my-app" \
  -F "name=MyApp" \
  -F "status=Complete" \
  -F "project=@project.tar.gz"
```

**Success (201)**:
```json
{
  "slug": "my-app",
  "name": "MyApp",
  "status": "Complete",
  "size": 1258291
}
```

**Error (409)** — duplicate slug:
```json
{
  "error": { "code": "DUPLICATE_SLUG", "message": "Project with slug \"my-app\" already exists" }
}
```

---

### GET /api/v1/projects/:slug

Get metadata for a single completed project.

```bash
TOKEN="eyJ..."
curl -k https://localhost:3443/api/v1/projects/my-app \
  -H "Authorization: Bearer $TOKEN"
```

**Response (200)**:
```json
{
  "id": 1,
  "name": "MyApp",
  "slug": "my-app",
  "status": "Complete",
  "dateCompleted": "2026-06-29",
  "size": 1258291
}
```

---

### GET /api/v1/projects/:slug/download

Download the project's tar.gz archive as a binary stream.

```bash
TOKEN="eyJ..."
curl -k https://localhost:3443/api/v1/projects/my-app/download \
  -H "Authorization: Bearer $TOKEN" \
  -o my-app.tar.gz
```

**Response (200)**: `Content-Type: application/gzip` binary stream.

---

## Error Responses

All errors follow a consistent shape:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable explanation"
  }
}
```

| Status | Error Code | Meaning |
|--------|-----------|---------|
| 400 | `MISSING_API_KEY` | Auth token request missing `api_key` field |
| 401 | `INVALID_API_KEY` | API key doesn't match the configured key |
| 401 | `UNAUTHORIZED` | Missing or malformed `Authorization` header |
| 401 | `TOKEN_EXPIRED` | JWT is invalid, expired, or signed with a different secret |
| 404 | `NOT_FOUND` | No idea matches the requested slug |
| 404 | `NO_IDEAS` | Database file exists but is empty or unparseable |
| 500 | `INTERNAL_ERROR` | Unexpected server error (check container logs) |

---

## File Structure (Module-Per-Responsibility)

The API's `scripts/` directory is split into single-concern modules:

```
slop-api/scripts/
├── api-server.js          # Express app: middleware, route definitions, HTTPS listen
├── parsers.js             # Markdown parsing: parseDatabase() + parseAppMarkdown()
├── auth.js                # JWT creation and verification middleware
└── db-utils.js            # Database utilities: generateSlug(), validateAppIdea(), normalizeDateFormat()
```

---

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `API_PORT` | `3443` | HTTPS listen port (must match docker-compose.yml port mapping) |
| `API_KEY` | random UUID | Pre-shared key to exchange for a JWT. Logged at startup if auto-generated |
| `JWT_SECRET` | random UUID | JWT signing secret. Auto-generated if empty — tokens invalidated on restart |
| `JWT_EXPIRY` | `1h` | Token lifetime (any string valid for `jsonwebtoken`'s `expiresIn`) |

---

## Quick Start

```bash
# 1. Start the container
docker compose up -d --build

# 2. Check the logs for the auto-generated API key
docker logs slop-generator | grep "\[API\]"

# 3. Get a token
curl -k -X POST https://localhost:3443/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"api_key":"<key-from-logs>"}'

# 4. Fetch a random idea
curl -k https://localhost:3443/api/v1/ideas/random \
  -H 'Authorization: Bearer <token>'

# 5. List all ideas
curl -k https://localhost:3443/api/v1/ideas \
  -H 'Authorization: Bearer <token>'
```
