# Backend POC — Progress Tracker

> **Purpose:** gate the stealth Meeting Assistant overlay behind Google sign-in + admin approval, with immediate admin ban. Free infra, JSON storage OK.
> **This file is the resume point.** If a session is interrupted, read this top-to-bottom and continue at the first unchecked `[ ]`.

_Last updated: 2026-10-14 — ALL MILESTONES M1–M8 COMPLETE. 38 tests green (34 backend + 4 app auth) + 11-check gate E2E. Remaining = account/deploy steps only the user can do (see SETUP-IN-THE-MORNING.md)._

## Locked decisions
- Node + Express + **direct Google OAuth** (verify Google ID tokens server-side). No Firebase/Supabase.
- Storage: **JSON file** now, behind a **store interface** with an **Upstash Redis REST** adapter for free persistent hosting.
- Admin: **web page + token API**, secured by `ADMIN_TOKEN`; admins also listed in `ADMIN_EMAILS` (default `sankararavind565@gmail.com`).
- Ban = **immediate**: app heartbeats `/me`; status is read live from the store so a ban locks the tool within minutes, even mid-session. Offline grace then fail-closed.
- `AUTH_MODE=stub` for local testing (no real Google needed); `AUTH_MODE=google` in production.

## Milestones
- [x] **M1 — Backend scaffold**: `backend/` package.json, env loader, config, `.env.example`, `.gitignore`. Deps installed: `express@4.21.2`, `google-auth-library@9.15.1`.
- [x] **M2 — Core modules**: `tokens.js` (HMAC session), `store/` (base+memory+json+upstash), `identity.js` (real Google + stub), `users.js` (signIn/approve/ban/unban/pending/delete/audit).
- [x] **M3 — HTTP server** (`server.js`): `/healthz`, `/auth/config`, `POST /auth/google`, `GET /me`, admin API (`/admin/api/users` list/create, `:email/approve|ban|unban|pending`, DELETE, `/audit`, `/config`), static admin page.
- [x] **M4 — Tests (zero bugs)**: 33 tests across tokens/store/identity/users/server — **all green**. `cd backend && node --test`.
- [x] **M5 — Admin web page**: `src/admin/public/` — token unlock, user table, approve/ban/unban/pending/delete, pre-approve form, audit log, auto-refresh. Verified served.
- [x] **M6 — Electron gating**: `src/auth/authClient.js` (session + heartbeat + offline grace + stub/google sign-in), `src/auth/oauthGoogle.js` (loopback PKCE), main.js `setupAuth()`+`enforceAuth()`+guards on captions/chat/doc, preload `window.auth`, `src/auth-gate.js` + gate markup/styles. Tested: 4 authClient tests + 11-check gate E2E (preload+gate+client+backend) all pass; real app boots clean with backend up and down.
- [x] **M7 — Deploy prep**: `backend/Dockerfile`, `backend/.dockerignore`, `render.yaml`, `backend/fly.toml`, `backend/DEPLOY.md`. Production config path validated (fail-fast without secrets; clean with them). Deploy NOT performed: no host creds/CLIs/Docker on this machine → it needs the user's account (morning checklist).
- [x] **M8 — Morning checklist**: `SETUP-IN-THE-MORNING.md` at repo root — local demo in 2 min + exact account/deploy steps.

## Follow-up features (post-M8)
- [x] **Live caption → ChatGPT (low latency)**: ChatGPT composer now mirrors the *live* transcript (interim + final) instead of appending only finalized phrases, so no more lag vs the Captions tab. `src/caption-feed.js` (pure assembler, 5 unit tests), diff-based `composerSetScript` in main.js (rewrites only the changed tail; 8-check Electron harness), renderer throttles pushes (140ms) and only pushes while the ChatGPT tab is the active view (so focusing the embedded view never steals the keyboard from other tabs; buffered + flushed on switch). preload: `setChatComposer`. caption-renderer dispatches `caption:update`/`caption:cleared`.

## Resume notes / current state
- Backend DONE + tested (M1–M5): `cd backend && node --test` → 34/34 pass. `node src/index.js` boots :8787 (stub+json), admin page /admin (dev token `dev-admin-token`).
- Electron gating DONE + tested (M6): gate blocks tool until approved; ban re-locks within a heartbeat; offline grace then fail-closed. App reads `MEETING_BACKEND_URL` or `userData/backend.json` {backendUrl}; defaults to http://localhost:8787. Google client id comes from backend `/auth/config` (app never holds the secret). Token at `userData/auth.json`.
- App-side auth test: `node --test test/auth-client.test.cjs` (4/4). Gate E2E harness lives in scratchpad (not committed).
- Next: M7 deploy prep + M8 morning checklist. Deploy itself needs the user's host account → will be a checklist item. Then final: rebuild packaged app (electron-builder) and relaunch.

## Things that NEED the user (morning checklist lives in SETUP-IN-THE-MORNING.md)
- Create a Google Cloud **OAuth 2.0 Client (Desktop app)** → gives `GOOGLE_CLIENT_ID` (+ secret). Only the user can do this.
- Create a free host account (Render or Fly) + optionally Upstash Redis (free) for persistence.
- Set env secrets on the host; deploy; put the deployed URL into the app config (`BACKEND_URL`).

## How to run (once built)
```
cd backend && npm install && npm test          # all tests
cd backend && npm start                          # starts on :8787 (AUTH_MODE=stub by default for local)
# admin page: http://localhost:8787/admin  (enter ADMIN_TOKEN from backend/.env)
```
