# Fedical

A small calendar-style planner for scheduled Fediverse posts.

## What it is
Fedical is a Mastodon-compatible planner where scheduled posts are managed in a calendar UI.
This repo includes:
- `apps/api` (Fastify + TypeScript backend)
- `apps/web` (React + Vite frontend)

## Tech
- Node.js
- TypeScript
- Fastify

## Author
Kea Cook

## Getting started

### Prerequisites
- Node.js installed (Current/stable recommended)

### Install
```bash
npm install
```

### Security env vars (recommended)

`FEDICAL_AUTH_ENCRYPTION_KEY`  
- Required to persist auth tokens to disk securely (AES-GCM).
- If missing, tokens are kept in memory only and are not saved to `fedical.auth.json`.

`FEDICAL_ALLOWED_REDIRECT_ORIGINS`  
- Comma-separated allowlist for OAuth redirect origins.
- Example: `http://127.0.0.1:5173,http://localhost:5173`

PowerShell (current session):
```powershell
$env:FEDICAL_AUTH_ENCRYPTION_KEY = "replace-with-a-long-random-secret"
$env:FEDICAL_ALLOWED_REDIRECT_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173"
```

### Run the API (`apps/api`)
```bash
npm run dev
```

The API listens on `http://127.0.0.1:3000`.

### Run the web app (`apps/web`)
```bash
cd apps/web
npm install
npm run dev
```

## Data storage (JSON, local)
Posts are persisted to a JSON file by default:
`apps/api/data/fedical.json`

Auth state is persisted to:
`apps/api/data/fedical.auth.json`

You can override the location:
- `FEDICAL_DATA_FILE` uses an exact file path
- `FEDICAL_DATA_DIR` uses a directory and saves `fedical.json` inside it
- `FEDICAL_AUTH_FILE` uses an exact auth file path

## Security model (current)
- API binds to localhost (`127.0.0.1`) by default.
- Fediverse instance URLs must be `https` and cannot target localhost.
- Post data is account-scoped: posts are tagged by owner account id and only visible/editable/deletable by that logged-in account.
- OAuth redirect targets must be in `FEDICAL_ALLOWED_REDIRECT_ORIGINS`.

## API overview

### Health
- `GET /health` -> `{ ok: true }`

### Auth (Mastodon OAuth)
- `POST /auth/connect` body `{ instanceUrl }`
- `POST /auth/register` body `{ instanceUrl }`
- `GET /auth/authorize?instance=<origin>&clientId=<clientId>&scope=read%20write&redirect=<url>`
- `GET /auth/callback?code=<code>&state=<state>`
- `GET /auth/me?instance=<origin>`
- `POST /auth/logout` body `{ instance }`

Successful callback returns:
```json
{
  "ok": true,
  "instance": "https://example.com",
  "account": {
    "id": "...",
    "username": "...",
    "acct": "...",
    "displayName": "..."
  }
}
```

### Planned posts
All `/posts` routes require a logged-in account for the selected instance.

Create a post:
```bash
curl -s -X POST http://127.0.0.1:3000/posts \
  -H "content-type: application/json" \
  -d '{"instance":"https://example.com","scheduledAt":"2026-02-10T12:30:00.000Z","text":"Hello world"}'
```

List posts in a date range:
```bash
curl -s "http://127.0.0.1:3000/posts?instance=https%3A%2F%2Fexample.com&from=2026-02-10T12:00:00.000Z&to=2026-02-10T13:00:00.000Z"
```

Update a post:
```bash
curl -s -X PATCH http://127.0.0.1:3000/posts/<id> \
  -H "content-type: application/json" \
  -d '{"text":"Updated text"}'
```

Delete a post:
```bash
curl -s -X DELETE http://127.0.0.1:3000/posts/<id>
```

On This Day (fetches from fediverse account history via token):
```bash
curl -s "http://127.0.0.1:3000/posts/on-this-day?instance=https%3A%2F%2Fexample.com&month=2&day=15&beforeYear=2026"
```
