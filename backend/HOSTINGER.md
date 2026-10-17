# Deploy the backend on Hostinger (Node.js Web App + MySQL)

Hostinger's **Node.js Web Apps** run a persistent Express server, and its **MySQL**
survives Git redeploys — so you don't need Render or Upstash. One platform, your
own domain + SSL.

**Requires a Business or Cloud plan** (Node.js Web Apps aren't on the basic/Premium
shared plan). Confirm in hPanel first.

---

## 1. Create the MySQL database
hPanel → **Databases → MySQL Databases** → create a database + user (give the user
all privileges on it). Note these four values:
- **Host** (often `localhost` when the app runs on the same hosting; hPanel shows the exact value)
- **Database name**
- **Username**
- **Password**

The app creates its own `app_state` table automatically on first run — you don't
make any tables.

## 2. Create the Node.js Web App
hPanel → **Web Apps** → **Create / Node.js** → deploy from **GitHub**:
- **Repository:** `devmocktail/Metting-Assistant` · **Branch:** `main`
- **Root directory:** `backend`   ← important (the server lives in the subfolder)
- **Entry file:** `src/index.js`
- **Node version:** 20 or 22
- **Install:** npm (auto-detected from `package-lock.json`)
- **Do NOT set a PORT** — Hostinger assigns one and the app reads it automatically
  (`process.env.PORT`).

## 3. Environment variables
In the Web App's **Environment variables** → **Import .env** (or add each). Use the
secrets you already generated — **do not commit them anywhere**:

```
NODE_ENV=production
AUTH_MODE=google
STORE=mysql
SESSION_SECRET=<the 64-char secret you generated>
ADMIN_TOKEN=<the admin token you generated>
ADMIN_EMAILS=sankararavind565@gmail.com
GOOGLE_CLIENT_ID=<your Google client id>
GOOGLE_CLIENT_SECRET=<your Google client secret>
MYSQL_HOST=<from step 1>
MYSQL_PORT=3306
MYSQL_USER=<from step 1>
MYSQL_PASSWORD=<from step 1>
MYSQL_DATABASE=<from step 1>
```
Hostinger keeps these across redeploys.

## 4. Deploy & verify
Deploy. Then on your domain:
- `https://<your-domain>/healthz` → `{"ok":true,"authMode":"google"}`
- `https://<your-domain>/admin` → paste your `ADMIN_TOKEN` → empty users table.

If it doesn't come up, open the Web App **logs** in hPanel. The server listens on
`process.env.PORT`; Hostinger should set that. A MySQL connection error there means
one of the `MYSQL_*` values is off.

## 5. Point the desktop app at it
On each user's PC, create
`%APPDATA%\private-meeting-overlay\backend.json`:
```json
{ "backendUrl": "https://<your-domain>" }
```
(or set env `MEETING_BACKEND_URL`). The app pulls the Google client id from the
backend, so nothing secret ships in the app.

## Day-to-day
- Approve/ban at `https://<your-domain>/admin` (your `ADMIN_TOKEN`), or the API.
- Your Gmail (`ADMIN_EMAILS`) is auto-approved as admin.
- User records live in MySQL, so they persist through restarts and redeploys.
