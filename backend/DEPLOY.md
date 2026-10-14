# Deploying the gating backend (free)

Two fully-free options. **Render** is the simplest; **Fly.io** persists JSON on a
volume so you don't need a separate store. Either way the backend is tiny.

The backend verifies Google sign-ins, records users (pending → approved → banned),
and exposes an admin page + API. The desktop app calls it on launch and every
~2 minutes, so a ban locks the tool within minutes.

---

## Prereqs (both options)

1. **Google OAuth client** (only you can create this):
   - https://console.cloud.google.com → create/select a project.
   - APIs & Services → OAuth consent screen → External → add your email as a Test user.
   - Credentials → Create credentials → OAuth client ID → **Desktop app**.
   - Copy the **Client ID** and **Client secret** — these become `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   - No redirect URIs to configure: the Desktop client allows `http://127.0.0.1:<port>` loopback automatically.

2. **Secrets** — generate two:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SESSION_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ADMIN_TOKEN
   ```

3. **ADMIN_EMAILS** = your Gmail (comma-separated for more). These accounts are
   auto-approved and can open the admin page/API.

---

## Option A — Render + Upstash (no disk needed)

1. **Upstash Redis** (free, persistent): https://console.upstash.com → create a
   Redis database → copy **REST URL** and **REST TOKEN**.
2. Push this repo to GitHub.
3. Render → **New → Blueprint** → pick the repo. It reads `render.yaml`.
4. Render generates `SESSION_SECRET` and `ADMIN_TOKEN`. Fill the rest when prompted:
   `ADMIN_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
5. Deploy. Your URL is `https://<name>.onrender.com`. Check `/healthz`.
   > Free Render sleeps after ~15 min idle; the first request then takes ~30 s. Fine for a POC.

## Option B — Fly.io + volume (JSON persists)

```
cd backend
fly launch --no-deploy          # pick an app name; keep the Dockerfile
fly volumes create data --size 1 --region iad
fly secrets set SESSION_SECRET=<hex> ADMIN_TOKEN=<hex> ADMIN_EMAILS=you@gmail.com \
  GOOGLE_CLIENT_ID=<id> GOOGLE_CLIENT_SECRET=<secret>
fly deploy
```
URL: `https://<app>.fly.dev`. Check `/healthz`. `STORE=json` + the `/data` volume
persist users across restarts.

## Option C — Docker anywhere
```
cd backend
docker build -t ma-backend .
docker run -p 8787:8787 \
  -e NODE_ENV=production -e AUTH_MODE=google \
  -e SESSION_SECRET=<hex> -e ADMIN_TOKEN=<hex> -e ADMIN_EMAILS=you@gmail.com \
  -e GOOGLE_CLIENT_ID=<id> -e GOOGLE_CLIENT_SECRET=<secret> \
  -e STORE=json -e DATA_DIR=/data -v ma-data:/data \
  ma-backend
```

---

## Point the desktop app at the backend

The app resolves its backend URL from, in order:
1. env `MEETING_BACKEND_URL`, else
2. `%APPDATA%\private-meeting-overlay\backend.json` → `{ "backendUrl": "https://<your-backend>" }`, else
3. `http://localhost:8787` (local dev).

Create that `backend.json` on each user's machine (or ship it). The app pulls the
Google **client id** from the backend's `/auth/config`, so the app never holds the
secret.

## Admin

- Page: `https://<your-backend>/admin` → paste `ADMIN_TOKEN` → approve/ban/unban.
- API (same token):
  ```
  curl -s https://<backend>/admin/api/users -H "X-Admin-Token: <ADMIN_TOKEN>"
  curl -s -X POST https://<backend>/admin/api/users/<email>/ban   -H "X-Admin-Token: <ADMIN_TOKEN>"
  curl -s -X POST https://<backend>/admin/api/users/<email>/approve -H "X-Admin-Token: <ADMIN_TOKEN>"
  ```

## Flip from test to real Google

Local dev runs `AUTH_MODE=stub` (fake sign-in, no Google). Production sets
`AUTH_MODE=google` (in render.yaml / fly.toml / docker env) + the Google client
vars. Nothing else changes.
