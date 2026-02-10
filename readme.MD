# Fedical

A small calendar-style planner for scheduled Fediverse posts.

## What it is
Fedical is a Mastodon-compatible client app where scheduled posts are managed in a calendar UI.
This repo currently contains the backend starter: a Fastify + TypeScript server.

## Tech
- Node.js
- TypeScript
- Fastify

## Getting started

### Prerequisites
- Node.js installed (Current/stable recommended)

### Install
```bash
npm install
```

### Run the API
```bash
npm run dev
```

The API listens on `http://127.0.0.1:3000`.

## Data storage (JSON, local)
Posts are persisted to a JSON file by default:
`apps/api/data/fedical.json`

You can override the location:
- `FEDICAL_DATA_FILE` uses an exact file path
- `FEDICAL_DATA_DIR` uses a directory and saves `fedical.json` inside it

## API overview

### Health
- `GET /health` -> `{ ok: true }`

### Auth (Mastodon OAuth)
- `POST /auth/connect` body `{ instanceUrl }`
- `POST /auth/register` body `{ instanceUrl }`
- `GET /auth/authorize?instance=<origin>&clientId=<clientId>&scope=read%20write`
- `GET /auth/callback?code=<code>&state=<state>`

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
Create a post (stores in memory + JSON):
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
