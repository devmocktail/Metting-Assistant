# Deploy the PHP backend on Hostinger (PHP/HTML website + MySQL)

Runs on your existing **Premium** plan (PHP 8 + MySQL) — no VPS, no Render, no
Upstash. Same API as the Node version, so the desktop app needs no changes.

## 1. Create the hosting + database
1. **Websites → Create website → PHP/HTML website** → attach a domain, ideally a
   **dedicated subdomain** (e.g. `meetingapi.yourdomain.com`). This gives it its
   own `public_html`.
2. **Databases → MySQL Databases** → create a DB + user (all privileges). Note:
   **host** (often `localhost`), **database name**, **user**, **password**.
3. In **Websites → (this site) → Advanced → PHP configuration**, make sure PHP is
   **8.1+**.

## 2. Upload the backend
Put the **contents of this `php-backend/` folder** into the site's `public_html`
so that `index.php` is at `public_html/index.php` (not in a subfolder).
- **File Manager:** zip the `php-backend` folder, upload the zip into
  `public_html`, extract, then move the files up so `index.php`, `.htaccess`,
  `app/`, and `admin/` sit directly in `public_html`.
- or **Git** (hPanel → Advanced → Git): deploy `devmocktail/Metting-Assistant`,
  branch `main`, then point the site root at the `php-backend` subfolder (or copy
  its contents to `public_html`).

Do **not** upload `dev-php.ini`, `tests/`, or any `data/` folder (they're only for
local testing).

## 3. Create config.php (your secrets)
Copy `config.php.example` to **`config.php`** in `public_html` and fill it in:
```php
<?php
return [
  'AUTH_MODE'            => 'google',
  'STORE'               => 'mysql',
  'SESSION_SECRET'      => '<long random string>',
  'ADMIN_TOKEN'         => '<your admin password>',
  'ADMIN_EMAILS'        => 'sankararavind565@gmail.com',
  'GOOGLE_CLIENT_ID'    => '<your Google client id>',
  'GOOGLE_CLIENT_SECRET'=> '<your Google client secret>',
  'MYSQL_HOST'          => '<from step 1>',
  'MYSQL_PORT'          => '3306',
  'MYSQL_USER'          => '<from step 1>',
  'MYSQL_PASSWORD'      => '<from step 1>',
  'MYSQL_DATABASE'      => '<from step 1>',
];
```
`.htaccess` blocks direct web access to `config.php`, `app/`, and `data/`.
The app creates its own `app_state` table on first run — you make no tables.

## 4. Verify
- `https://<your-subdomain>/healthz` → `{"ok":true,"authMode":"google"}`
- `https://<your-subdomain>/admin` → paste your `ADMIN_TOKEN` → empty users table.

If `/healthz` errors, check: PHP 8.x selected, `config.php` present and valid, and
the `MYSQL_*` values correct (a DB error surfaces as `storage unavailable`).

## 5. Point the desktop app at it
On each PC, `%APPDATA%\private-meeting-overlay\backend.json`:
```json
{ "backendUrl": "https://<your-subdomain>" }
```
Restart the app → it signs in via Google against your Hostinger backend.

## Notes
- Requires the PHP extensions **pdo_mysql**, **curl**, **openssl**, **mbstring**
  (all standard on Hostinger).
- Admin and user management are identical to the Node version (same `/admin` page,
  same API, same approve/ban/heartbeat behavior).
