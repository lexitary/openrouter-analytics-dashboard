# OpenRouter dashboard

A vibecoded private, local dashboard for OpenRouter credits and usage. The interface follows the Activity overview: credits, spend, requests, token volume, cache hit rate, top API keys, model usage, spend over time, and prompt/completion/reasoning tokens.

Made entirely with GPT-6 Luna medium/high it cost me ~50¢ so far :)

<img width="1673" height="1192" alt="image" src="https://github.com/user-attachments/assets/4ad545d6-1d85-49ee-a3fd-dbbd401662cb" />

## Run locally

Requires Node.js 22.12 or newer.

1. From this directory, copy `.env.example` to `.env`.
2. Create an OpenRouter **Management API key** and set `OPENROUTER_MANAGEMENT_KEY` in `.env`.
3. Run `npm install`, then `npm run dev`.
4. Open the local URL printed by the server (normally `http://127.0.0.1:4173`).

The key is read only by the local Node server. It is not compiled into the frontend, returned from the local API, or stored in browser storage. Keep `.env` private; it is excluded from Git.

## Build and preview

- `npm run build` type-checks the app and creates `dist/`.
- `npm run preview` serves the built app through the same local server-side API proxy.

## Data notes

The app reads credits from OpenRouter's credits endpoint and discovers supported analytics fields from the analytics metadata endpoint before querying usage. It gracefully leaves unavailable metrics blank. API key rows use completion/generated tokens where the account exposes that metric. OpenRouter may return key IDs instead of key names; when no matching key label is available, the dashboard displays a shortened identifier.

The selected ranges are rolling 24-hour, 7-day, and 30-day windows. The analytics API may aggregate/cap data differently from the OpenRouter website. This is a read-only dashboard: it does not create, update, or delete keys.
