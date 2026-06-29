# API Design Conventions

## HTTP Status Codes — Be Precise

Return the most specific status code available. Don't default to 200 or 500.

```text
2xx — Success
  200 OK            — Standard success (GET, PATCH)
  201 Created       — Resource created (POST). MUST include Location header
  202 Accepted      — Async processing started. Return status endpoint
  204 No Content    — Success, no body (DELETE)

3xx — Redirection
  301 Moved Permanently — Resource has a new permanent URL
  304 Not Modified  — Cached response still valid (ETag/If-None-Match)

4xx — Client Error
  400 Bad Request   — Malformed input (validation errors)
  401 Unauthorized  — Missing or invalid credentials
  403 Forbidden     — Authenticated but not authorized
  404 Not Found     — Resource doesn't exist
  409 Conflict      — Resource state conflict (duplicate, version mismatch)
  422 Unprocessable — Semantic validation failure (well-formed but wrong)
  429 Too Many Requests — Rate limit exceeded

5xx — Server Error
  500 Internal Error — Unexpected failure (bug). Never return by default
  502 Bad Gateway   — Upstream returned invalid response
  503 Unavailable   — Temporarily down (maintenance, overload)
  504 Gateway Timeout — Upstream didn't respond in time
```

- **Never return 500 by catching and swallowing.** 500 means "bug." Log the error and let it surface.
- **Never return 200 with an error message.** `{ "error": "not found" }` with 200 breaks every HTTP client, cache, and monitoring system.
- **401 vs 403**: 401 = "who are you?" (missing auth). 403 = "I know who you are, but no."

## Error Response Shape — Standardize

Every error response MUST use the same structure.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description of what went wrong",
    "details": [
      {
        "field": "email",
        "reason": "must be a valid email address",
        "value": "not-an-email"
      }
    ],
    "requestId": "req_a1b2c3d4"
  }
}
```

- **`code`**: machine-readable, stable, uppercase with underscores (`INSUFFICIENT_FUNDS`, not `insufficientFunds` or `error 12`)
- **`message`**: human-readable, safe to show in UI, never includes stack traces or internal paths
- **`details`**: array of field-level errors for validation failures. Empty or omitted for non-validation errors
- **`requestId`**: correlation ID for debugging — returned in response headers too
- **Never leak internals**: No SQL errors, stack traces, file paths, or framework names in error responses

## Versioning

APIs MUST be versioned. Pick one strategy and stick to it.

```text
# URL path versioning (most common, simplest to cache/rout)
GET /api/v1/users

# Header versioning (cleaner URLs, harder to test in browser)
GET /api/users
Accept: application/vnd.myapp.v2+json
```

- **URL path versioning** is the safe default. Easier to route, cache, document, and test.
- **Major version only**: `v1`, `v2`, not `v2.1.3`. Fine-grained changes use feature flags or backwards-compatible additions.
- **Never break a published version.** New field additions are fine on existing versions — but don't change field types, remove fields, or change semantics.
- Deprecation: set `Sunset` and `Deprecation` headers. Announce with at least one major version overlap.

## Authentication & Authorization

Every API endpoint must authenticate unless explicitly public.

```text
# Authentication: verify identity
Authorization: Bearer <token>

# Authorization: verify permissions
- Check permissions AFTER authentication
- Return 401 for missing/invalid credentials
- Return 403 for valid credentials but insufficient permissions
- Never differentiate 401 and 403 based on resource existence (prevents enumeration)
```
