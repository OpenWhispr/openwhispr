# OpenWhispr API

Use the OpenWhispr REST API to manage notes, folders, transcriptions, and usage programmatically.

## Authentication

All requests require a Bearer token. Generate an API key from the OpenWhispr desktop app under **Settings > API Keys**.

```
Authorization: Bearer owk_live_YOUR_KEY
```

Keys use scoped permissions: `notes:read`, `notes:write`, `transcriptions:read`, `usage:read`.

## Base URL

```
https://api.openwhispr.com/api/v1
```

## Response Format

**Success (single resource):**
```json
{ "data": { ... } }
```

**Success (list with pagination):**
```json
{ "data": [...], "has_more": true, "next_cursor": "2026-04-15T..." }
```

**Error:**
```json
{ "error": { "code": "not_found", "message": "Note not found" } }
```

## Rate Limits

Limits are per API key. Headers returned on every response:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Requests allowed per minute |
| `X-RateLimit-Remaining` | Requests remaining in window |
| `X-RateLimit-Reset` | Unix timestamp when window resets |
| `Retry-After` | Seconds to wait (only on 429) |

| Plan | Per Minute | Per Day |
|------|-----------|---------|
| Free | 30 | 1,000 |
| Pro | 120 | 10,000 |
| Business | 300 | 50,000 |

## Endpoints

### Notes

#### List Notes
```
GET /notes/list?limit=50&cursor=CURSOR&folder_id=UUID
```
- **Scope:** `notes:read`
- **Query:** `limit` (1-100, default 50), `cursor` (pagination), `folder_id` (optional filter)
- **Returns:** Paginated list with `has_more` and `next_cursor`

#### Get Note
```
GET /notes/{id}
```
- **Scope:** `notes:read`
- **Path:** `id` — UUID of the note

#### Create Note
```
POST /notes/create
Content-Type: application/json

{
  "content": "Note text here",
  "title": "Optional title",
  "note_type": "personal",
  "folder_id": "UUID"
}
```
- **Scope:** `notes:write`
- **Body:** `content` (required), `title`, `note_type` (`personal` | `meeting` | `upload`), `folder_id`
- **Returns:** 201 with created note

#### Update Note
```
PATCH /notes/{id}
Content-Type: application/json

{
  "title": "Updated title",
  "content": "Updated content",
  "folder_id": "UUID"
}
```
- **Scope:** `notes:write`
- **Body:** `title`, `content`, `enhanced_content`, `folder_id` (all optional)

#### Delete Note
```
DELETE /notes/{id}
```
- **Scope:** `notes:write`
- **Returns:** 204 No Content

#### Search Notes
```
POST /notes/search
Content-Type: application/json

{
  "query": "meeting with design team",
  "limit": 20
}
```
- **Scope:** `notes:read`
- **Body:** `query` (1-500 chars, required), `limit` (1-50, default 20)
- **Search:** Hybrid semantic (vector) + full-text search with relevance scoring

### Folders

#### List Folders
```
GET /folders/list
```
- **Scope:** `notes:read`

#### Create Folder
```
POST /folders/create
Content-Type: application/json

{
  "name": "Work",
  "sort_order": 1
}
```
- **Scope:** `notes:write`
- **Body:** `name` (1-100 chars, required), `sort_order` (optional integer)
- **Limits:** Max 50 folders per user

### Transcriptions

#### List Transcriptions
```
GET /transcriptions/list?limit=50&cursor=CURSOR
```
- **Scope:** `transcriptions:read`
- **Returns:** Paginated list of transcription history (text, word count, provider, duration)

#### Get Transcription
```
GET /transcriptions/{id}
```
- **Scope:** `transcriptions:read`

### Usage

#### Get Usage Stats
```
GET /usage
```
- **Scope:** `usage:read`
- **Returns:** `words_used`, `words_remaining`, `limit`, `plan`, `is_subscribed`, `current_period_end`, `billing_interval`

## MCP Server

For AI assistant integration (Claude, Cursor, VS Code), connect to the remote MCP server:

```
https://mcp.openwhispr.com/mcp
```

Pass your API key via the `Authorization: Bearer` header. All API endpoints above are available as MCP tools.

## Examples

### List recent notes with curl
```bash
curl -H "Authorization: Bearer owk_live_YOUR_KEY" \
  https://api.openwhispr.com/api/v1/notes/list?limit=10
```

### Create a note
```bash
curl -X POST \
  -H "Authorization: Bearer owk_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Remember to review PR #42", "title": "TODO"}' \
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
