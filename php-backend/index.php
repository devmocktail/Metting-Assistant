<?php
// Front controller for the gating backend (PHP port of the Node server).
require __DIR__ . '/app/Http.php';
require __DIR__ . '/app/Config.php';
require __DIR__ . '/app/Tokens.php';
require __DIR__ . '/app/Store.php';
require __DIR__ . '/app/Google.php';
require __DIR__ . '/app/Users.php';

$config = Config::load();
$tokens = new Tokens($config['sessionSecret']);
$google = new Google($config);

try {
    $store = new Store($config);
    $store->init();
} catch (Throwable $e) {
    Http::error('storage unavailable', 500);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = rtrim($path, '/');
if ($path === '') {
    $path = '/';
}

$getHeader = function (string $name): string {
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (!empty($_SERVER[$key])) {
        return $_SERVER[$key];
    }
    if (!empty($_SERVER['REDIRECT_' . $key])) {
        return $_SERVER['REDIRECT_' . $key];
    }
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            if (strcasecmp($k, $name) === 0) {
                return $v;
            }
        }
    }
    return '';
};
$bearer = function () use ($getHeader): string {
    $h = $getHeader('Authorization');
    return strncmp($h, 'Bearer ', 7) === 0 ? trim(substr($h, 7)) : '';
};
$jsonBody = function (): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
};
$issueSession = function (array $identity) use ($store, $config, $tokens) {
    $user = Users::signIn($store, $config, $identity);
    $token = $tokens->sign(
        ['email' => $user['email'], 'sub' => $user['googleSub'] ?? ($identity['sub'] ?? '')],
        $config['sessionTtlMs']
    );
    Http::json([
        'token'   => $token,
        'user'    => Users::summary($user),
        'allowed' => Users::isAllowed($config, $user),
        'status'  => $user['status'],
        'admin'   => Users::isAdmin($config, $user['email']),
    ]);
};

try {
    if ($method === 'GET' && $path === '/') {
        header('Content-Type: text/html; charset=utf-8');
        // The single-file build inlines the marketing landing page as LANDING_HTML;
        // if it isn't present (dev/separated), fall back to a small status page.
        if (defined('LANDING_HTML')) {
            echo LANDING_HTML;
            exit;
        }
        echo '<!doctype html><meta charset="utf-8"><title>Meeting Assistant . backend</title>'
            . '<body style="font-family:system-ui,Segoe UI,sans-serif;background:#0d0f12;color:#e3e6ea;margin:0;padding:48px;line-height:1.6">'
            . '<h2 style="margin:0 0 6px">A2solveX Meeting Assistant - backend</h2>'
            . '<p>Status: <b style="color:#50dea3">running</b> . auth mode: <b>' . htmlspecialchars($config['authMode']) . '</b></p>'
            . '<p style="margin-top:22px"><a href="admin/" style="color:#50dea3;font-weight:700">Open the admin page -></a></p>'
            . '<p style="color:#8b929c">API endpoints: <code>/healthz</code>, <code>/auth/config</code>, <code>/auth/google</code>, <code>/me</code>, <code>/admin/api/*</code>.</p>'
            . '</body>';
        exit;
    }

    if ($method === 'GET' && $path === '/healthz') {
        Http::json(['ok' => true, 'authMode' => $config['authMode']]);
    }

    if ($method === 'GET' && $path === '/auth/config') {
        Http::json([
            'authMode'            => $config['authMode'],
            'googleClientId'      => $config['googleClientId'],
            'heartbeatIntervalMs' => $config['heartbeatIntervalMs'],
            'offlineGraceMs'      => $config['offlineGraceMs'],
            'sessionTtlMs'        => $config['sessionTtlMs'],
        ]);
    }

    if ($method === 'POST' && $path === '/auth/google') {
        if ($config['authMode'] === 'stub' && $config['devAuthSecret'] !== '') {
            if (!hash_equals($config['devAuthSecret'], $getHeader('X-Dev-Auth'))) {
                throw new HttpException('dev auth required', 401);
            }
        }
        $body = $jsonBody();
        $idToken = (string) ($body['idToken'] ?? '');
        $identity = $config['authMode'] === 'stub'
            ? $google->resolveStub($idToken)
            : $google->resolveIdToken($idToken);
        $issueSession($identity);
    }

    if ($method === 'POST' && $path === '/auth/google/code') {
        $body = $jsonBody();
        $identity = $google->exchangeCode(
            (string) ($body['code'] ?? ''),
            (string) ($body['codeVerifier'] ?? ''),
            (string) ($body['redirectUri'] ?? '')
        );
        $issueSession($identity);
    }

    if ($method === 'GET' && $path === '/me') {
        $payload = $tokens->verify($bearer());
        if (!$payload || empty($payload['email'])) {
            Http::error('invalid or expired session', 401);
        }
        $current = Users::touch($store, $payload['email']);
        if (!$current) {
            Http::json(['user' => ['email' => $payload['email'], 'status' => 'unknown'], 'allowed' => false, 'status' => 'unknown']);
        }
        Http::json([
            'user'    => Users::summary($current),
            'allowed' => Users::isAllowed($config, $current),
            'status'  => $current['status'],
            'admin'   => Users::isAdmin($config, $current['email']),
            'command' => $current['command'] ?? null,
        ]);
    }

    if (strpos($path, '/admin/api') === 0) {
        $provided = $getHeader('X-Admin-Token');
        if ($provided === '') {
            $provided = $bearer();
        }
        if ($provided === '' || !hash_equals($config['adminToken'], $provided)) {
            Http::error('admin authorization required', 401);
        }
        $actor = strtolower(trim($getHeader('X-Admin-Email'))) ?: 'admin';
        $sub = substr($path, strlen('/admin/api'));

        if ($method === 'GET' && $sub === '/users') {
            Http::json(['users' => Users::listUsers($store, $config)]);
        }
        if ($method === 'GET' && $sub === '/audit') {
            $limit = max(1, min((int) ($_GET['limit'] ?? 200), 1000));
            Http::json(['audit' => $store->listAudit($limit)]);
        }
        if ($method === 'GET' && $sub === '/config') {
            Http::json(['authMode' => $config['authMode'], 'adminEmails' => $config['adminEmails']]);
        }
        if ($method === 'POST' && $sub === '/users') {
            $body = $jsonBody();
            $email = strtolower(trim((string) ($body['email'] ?? '')));
            if (!Google::isEmail($email)) {
                throw new HttpException('invalid email', 400);
            }
            $user = Users::setStatus($store, $config, $actor, $email, (string) ($body['status'] ?? 'approved'), $body['notes'] ?? null);
            Http::json(['user' => Users::summary($user)]);
        }
        if ($method === 'POST' && preg_match('#^/users/([^/]+)/(approve|ban|unban|pending)$#', $sub, $m)) {
            $email = strtolower(urldecode($m[1]));
            if (!Google::isEmail($email)) {
                throw new HttpException('invalid target email', 400);
            }
            $map = ['approve' => 'approved', 'ban' => 'banned', 'unban' => 'approved', 'pending' => 'pending'];
            $user = Users::setStatus($store, $config, $actor, $email, $map[$m[2]]);
            Http::json(['user' => Users::summary($user)]);
        }
        if ($method === 'POST' && preg_match('#^/users/([^/]+)/uninstall$#', $sub, $m)) {
            $email = strtolower(urldecode($m[1]));
            if (!Google::isEmail($email)) {
                throw new HttpException('invalid target email', 400);
            }
            $user = Users::uninstall($store, $config, $actor, $email);
            Http::json(['user' => Users::summary($user)]);
        }
        if ($method === 'DELETE' && preg_match('#^/users/([^/]+)$#', $sub, $m)) {
            $email = strtolower(urldecode($m[1]));
            if (!Google::isEmail($email)) {
                throw new HttpException('invalid target email', 400);
            }
            Http::json(['deleted' => Users::remove($store, $actor, $email)]);
        }
        Http::error('not found', 404);
    }

    Http::error('not found', 404);
} catch (HttpException $e) {
    Http::error($e->getMessage(), $e->status);
} catch (Throwable $e) {
    Http::error('internal error', 500);
}
