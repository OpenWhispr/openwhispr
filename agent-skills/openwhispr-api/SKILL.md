---
name: openwhispr-api
description: Use this skill when building integrations with the OpenWhispr REST API, calling OpenWhispr endpoints, managing notes/folders/transcriptions programmatically, or connecting to the OpenWhispr MCP server. Covers authentication, all V1 endpoints, pagination, rate limits, error handling, and the remote MCP server.
---

# OpenWhispr API v1

Use this reference when making requests to the OpenWhispr REST API. All endpoints are under the V1 path and require API key authentication.

## Authentication

Pass the API key as a Bearer token in the `Authorization` header on every request.

```
Authorization: Bearer owk_live_YOUR_KEY
```

Generate keys from the OpenWhispr desktop app under **Settings > API Keys**. Keys start with `owk_live_` and are shown once at creation.

### Scopes

Each key has scoped permissions. The API rejects requests missing the required scope with `403 Forbidden`.

| Scope | Grants |
|-------|--------|
| `notes:read` | List, get, and search notes. List folders. |
| `notes:write` | Create, update, and delete notes. Create folders. |
| `transcriptions:read` | List and get transcriptions. |
| `usage:read` | Read usage statistics. |

## Base URL

```
https://api.openwhispr.com/api/v1
```

## Response Envelope

Wrap all responses in a consistent envelope.

**Single resource:**
```json
{ "data": { "id": "uuid", "title": "My note", ... } }
```

**Paginated list:**
```json
{
  "data": [{ ... }, { ... }],
  "has_more": true,
  "next_cursor": "2026-04-15T10:30:00.000Z"
}
```

**Error:**
```json
{ "error": { "code": "not_found", "message": "Note not found" } }
```

### Error Codes

| HTTP Status | Code | Meaning |
|-------------|------|---------|
| 400 | `validation_error` | Invalid request body or query params |
| 401 | `invalid_api_key` | Missing, malformed, expired, or revoked key |
| 403 | `forbidden` | Key lacks required scope |
| 404 | `not_found` | Resource does not exist or belongs to another user |
| 405 | `method_not_allowed` | Wrong HTTP method |
| 409 | `conflict` | Duplicate resource (e.g. folder name) |
| 429 | `rate_limited` | Rate limit exceeded — check `Retry-After` header |
| 500 | `internal_error` | Server error |

## Rate Limits

Enforced per API key with minute and daily windows. Search requests cost 5x against the rate limit.

| Plan | Per Minute | Per Day |
|------|-----------|---------|
| Free | 30 | 1,000 |
| Pro | 120 | 10,000 |
| Business | 300 | 50,000 |

Response headers on every request:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Max requests per minute |
| `X-RateLimit-Remaining` | Remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when window resets |
| `Retry-After` | Seconds to wait (only on 429) |

## Pagination

List endpoints use cursor-based pagination. Pass the `next_cursor` value from a previous response as the `cursor` query parameter to fetch the next page. When `has_more` is `false`, there are no more results.

```
GET /notes/list?limit=50&cursor=2026-04-15T10:30:00.000Z
```

## Endpoints

### Notes

**List Notes** — `GET /notes/list`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | integer | No | 1-100, default 50 |
| `cursor` | string | No | Pagination cursor |
| `folder_id` | UUID | No | Filter by folder |
Scope: `notes:read`

**Get Note** — `GET /notes/{id}`
Scope: `notes:read`. Returns 404 if the note does not exist or is deleted.

**Create Note** — `POST /notes/create`
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Note body text |
| `title` | string | No | Note title |
| `enhanced_content` | string | No | Cleaned/enhanced version |
| `note_type` | enum | No | `personal` (default), `meeting`, `upload` |
| `folder_id` | UUID | No | Target folder |
Scope: `notes:write`. Returns `201` with the created note.

**Update Note** — `PATCH /notes/{id}`
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | No | New title |
| `content` | string | No | New content |
| `enhanced_content` | string | No | New enhanced content |
| `folder_id` | UUID | No | Move to folder |
Scope: `notes:write`. All fields optional — only provided fields are updated.

**Delete Note** — `DELETE /notes/{id}`
Scope: `notes:write`. Soft-deletes the note. Returns `204 No Content`.

**Search Notes** — `POST /notes/search`
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Search text (1-500 chars) |
| `limit` | integer | No | 1-50, default 20 |
Scope: `notes:read`. Uses hybrid semantic (vector) + full-text search with relevance scoring. Costs 5x against rate limit.

### Folders

**List Folders** — `GET /folders/list`
Scope: `notes:read`. Returns all folders sorted by `sort_order` then `created_at`.

**Create Folder** — `POST /folders/create`
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Folder name (1-100 chars) |
| `sort_order` | integer | No | Sort position |
Scope: `notes:write`. Max 50 folders per user. Returns `409` if name already exists.

### Transcriptions

**List Transcriptions** — `GET /transcriptions/list`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | integer | No | 1-100, default 50 |
| `cursor` | string | No | Pagination cursor |
Scope: `transcriptions:read`. Returns transcription history with `text`, `word_count`, `source`, `provider`, `model`, `language`, `audio_duration_ms`, `processing_ms`.

**Get Transcription** — `GET /transcriptions/{id}`
Scope: `transcriptions:read`.

### Usage

**Get Usage** — `GET /usage`
Scope: `usage:read`. Returns:
- `words_used` — Words consumed this period
- `words_remaining` — Words left in quota
- `limit` — Total word quota
- `plan` — Current plan (`free`, `pro`, `business`)
- `is_subscribed` — Whether user has active subscription
- `current_period_end` — End of current billing period
- `billing_interval` — Billing cycle

## MCP Server

For AI assistant integration (Claude, Cursor, VS Code), connect to the remote MCP server at:

```
https://mcp.openwhispr.com/mcp
```

Pass the API key via `Authorization: Bearer` header. All V1 endpoints are available as MCP tools. The server uses Streamable HTTP transport (stateless, no sessions).

### Claude Code
```bash
claude mcp add openwhispr --transport http https://mcp.openwhispr.com/mcp \
  --header "Authorization: Bearer owk_live_YOUR_KEY"
```

### Cursor / VS Code
```json
{
  "mcpServers": {
    "openwhispr": {
      "url": "https://mcp.openwhispr.com/mcp",
      "headers": { "Authorization": "Bearer owk_live_YOUR_KEY" }
    }
  }
}
```

## Examples

### List recent notes
```bash
curl -H "Authorization: Bearer owk_live_YOUR_KEY" \
  "https://api.openwhispr.com/api/v1/notes/list?limit=10"
```

### Create a note in a folder
```bash
curl -X POST \
  -H "Authorization: Bearer owk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Remember to review PR #42", "title": "TODO", "folder_id": "UUID"}' \
  https://api.openwhispr.com/api/v1/notes/create
```

### Search notes
```bash
curl -X POST \
  -H "Authorization: Bearer owk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "quarterly budget discussion"}' \
  https://api.openwhispr.com/api/v1/notes/search
```

### Paginate through all notes
```bash
cursor=""
while true; do
  response=$(curl -s -H "Authorization: Bearer owk_live_YOUR_KEY" \
    "https://api.openwhispr.com/api/v1/notes/list?limit=100&cursor=${cursor}")
  echo "$response" | jq '.data[]'
  has_more=$(echo "$response" | jq -r '.has_more')
  [ "$has_more" != "true" ] && break
  cursor=$(echo "$response" | jq -r '.next_cursor')
done
```

### Check usage
```bash
curl -H "Authorization: Bearer owk_live_YOUR_KEY" \
  https://api.openwhispr.com/api/v1/usage
```
