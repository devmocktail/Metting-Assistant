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

## Pricing + Razorpay (added 2026-10-20)
- **Model:** everyone signs up onto a **7-day free trial** (self-serve: new Google sign-ins are auto-`approved` onto `plan=trial`, no admin wait; admin can still ban/remove). **Pro = ₹999/month** via **Razorpay Subscriptions**. `SELF_SERVE=false` restores legacy admin-approval.
- **Gate UI (`src/auth-gate.js` + `index.html` + `styles.css`):** before sign-in a **pricing screen** shows two cards (Free trial / Pro ₹999/mo). Picking one → welcome → Continue with Google (passes the plan). Locked states `trial_expired` / `payment_required` show an **Upgrade to Pro** button → `window.auth.subscribe()`. Gate also now has its own **minimize/maximize** buttons (`#gate-minimize/#gate-maximize`).
- **App:** `authClient.js` gained `subscribe()` + plan/trial/subscription state + `reason`. `main.js` opens a Razorpay checkout **payment window** to the backend `/pay` page; success (page title → `PAID`) or close triggers `recheck()`. preload: `auth.subscribe()`, `auth.signInGoogle(plan)`. Single-instance lock added (`requestSingleInstanceLock`). Window controls: title bar is no-drag with only inert areas draggable (fixes buttons dying after a drag); always-on-top is dropped while minimized/maximized and re-asserted on restore.
- **Backend (PHP):** new `app/Razorpay.php` (create/fetch subscription, verify payment + webhook signatures). `Config.php` adds `SELF_SERVE, TRIAL_DAYS, PLAN_AMOUNT_INR, RAZORPAY_KEY_ID/SECRET/PLAN_ID/WEBHOOK_SECRET`. `Users.php`: `accessDetail()` (trial window / active-pro gating; legacy approved users with no `plan` stay allowed), `findBySubscription`, `setSubscription`; `signIn` starts self-serve trials. `index.php` routes: `POST /billing/subscribe`, `GET /pay`, `POST /billing/verify`, `POST /billing/webhook`; sign-in & `/me` now return plan/trial/reason. `build-single.php` bundles Razorpay. **Rebuilt `php-backend/dist/index.php` (96 KB).**
- **Tests:** `php-backend/tests/unit.php` extended (self-serve trial / expiry / pro active / payment_required / legacy) — needs pdo_sqlite to run; logic also verified via scratchpad fake-store test. `test/auth-client.test.cjs` still 4/4. All JS/PHP lint clean.
- **USER TO DO:** (1) re-upload `php-backend/dist/index.php` to Hostinger; add new keys to `config.php`. (2) For Pro: create a Razorpay account → monthly ₹999 **Plan** → put `plan_xxx` in `RAZORPAY_PLAN_ID`, test keys in `RAZORPAY_KEY_ID/SECRET`; add a webhook (`subscription.charged/cancelled/...`) pointing to `/billing/webhook` with its secret in `RAZORPAY_WEBHOOK_SECRET`. Trial works without any Razorpay keys.

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
