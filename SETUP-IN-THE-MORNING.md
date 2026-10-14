# Good morning — here's where things stand and your checklist

**What got built last night:** a complete, tested gating backend + the Electron app
is now locked behind it. A user must sign in with Google; you (admin) approve them
before the tool works; you can ban anyone and the tool locks within ~2 minutes,
even mid-session. All free infra, JSON storage (swappable). Phase 2 (your own LLM)
is untouched, as agreed.

**Status:** everything is **built and tested locally — 38 automated tests green**
(34 backend + 4 app auth). The only things I could not do while you slept are the
steps that need *your* accounts: creating the Google OAuth client and signing up
for a host. Those are below and take ~20 minutes total.

> Full detail + decisions: `PROGRESS.md`. Deploy specifics: `backend/DEPLOY.md`.

---

## 0. See it work right now, locally (2 min, no accounts)

```powershell
cd D:\1\Meeting-Assistant-full\backend
npm install           # already done, safe to re-run
node src\index.js     # starts on http://localhost:8787  (stub auth, dev admin token)
```
Then launch the app (another terminal):
```powershell
cd D:\1\Meeting-Assistant-full
$env:MEETING_BACKEND_URL="http://localhost:8787"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
```
- The app opens to a **sign-in gate**. In stub mode it shows a dev email box →
  type any email → **Dev sign in** → you'll see **"Waiting for approval."**
- Open **http://localhost:8787/admin**, paste token `dev-admin-token`, click
  **Approve** → within a moment hit **Check again** in the app → the tool unlocks.
- Click **Ban** in the admin page → the app re-locks on the next heartbeat.
  That's the whole product loop.

Run the tests any time:
```powershell
cd backend ; node --test          # 34 backend tests
cd .. ; node --test test\auth-client.test.cjs   # 4 app auth tests
```

---

## 1. Create the Google OAuth client (~5 min) — only you can

1. https://console.cloud.google.com → create/select a project.
2. **OAuth consent screen** → External → add your Gmail under **Test users**
   (keeps it in testing; no Google review needed for a POC).
3. **Credentials → Create credentials → OAuth client ID → Desktop app**.
4. Copy the **Client ID** and **Client secret**. (No redirect URIs needed — the
   desktop loopback is allowed automatically.)

## 2. Deploy the backend (~10 min) — pick ONE

Both are free. Full commands in `backend/DEPLOY.md`.
- **Render** (easiest): push repo to GitHub → Render → New → Blueprint (reads
  `render.yaml`) → fill `GOOGLE_CLIENT_ID/SECRET`, `ADMIN_EMAILS`, and Upstash REST
  URL+token (free Upstash Redis for storage). Render auto-generates the secrets.
- **Fly.io** (JSON persists on a free volume): `cd backend && fly launch --no-deploy`,
  `fly volumes create data --size 1`, `fly secrets set ...`, `fly deploy`.

Generate the two secrets with:
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
(one for `SESSION_SECRET`, one for `ADMIN_TOKEN`).

## 3. Point the app at your deployed backend

On each user's PC, create
`%APPDATA%\private-meeting-overlay\backend.json`:
```json
{ "backendUrl": "https://your-backend.onrender.com" }
```
(or set env `MEETING_BACKEND_URL`). The app reads the Google client id from the
backend, so nothing secret ships in the app.

## 4. Distribute the app

```powershell
cd D:\1\Meeting-Assistant-full
npm run dist   # if it fails on the worker step, see note in PROGRESS.md; the
               # installer at dist\A2solveX-Meeting-Assistant-Setup-0.1.0.exe is current
```
Send the installer + create the `backend.json` on each salesperson's machine.

## 5. Day-to-day admin

- **Approve / ban / unban**: `https://<backend>/admin` (paste your `ADMIN_TOKEN`),
  or the API (same token) — see `backend/DEPLOY.md`.
- Banning a departing salesperson locks their tool within ~2 minutes.
- Your own Gmail (in `ADMIN_EMAILS`) is auto-approved.

---

## Open questions for you (I made safe defaults; change if you want)
- **Heartbeat/grace**: re-check every 2 min; if offline, tool stays unlocked 10 min
  then locks. Tune via env `HEARTBEAT_INTERVAL_MS` / `OFFLINE_GRACE_MS`.
- **Storage**: JSON (Fly) or Upstash (Render). Both free. Move to a DB later with a
  new store adapter — the interface is ready (`backend/src/store/`).
- **One ChatGPT caveat** from before: Google sign-in *inside* the ChatGPT tab can be
  finicky in an embedded browser; email/password is reliable. (Unrelated to this
  backend's Google sign-in, which uses your system browser.)
