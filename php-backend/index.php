<?php
// Front controller for the gating backend (PHP port of the Node server).
require __DIR__ . '/app/Http.php';
require __DIR__ . '/app/Config.php';
require __DIR__ . '/app/Tokens.php';
require __DIR__ . '/app/Store.php';
require __DIR__ . '/app/Google.php';
require __DIR__ . '/app/Razorpay.php';
require __DIR__ . '/app/Users.php';

$config = Config::load();
$tokens = new Tokens($config['sessionSecret']);
$google = new Google($config);
$razorpay = new Razorpay($config);

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
// Shared shape for sign-in and /me responses: access + plan/trial/subscription.
// An optional device verdict (from Users::checkDevice) overrides access: a machine
// that isn't the account's bound one is denied with reason 'device_mismatch'.
$accessPayload = function (array $user, ?array $device = null) use ($config): array {
    $d = Users::accessDetail($config, $user);
    $allowed = $d['allowed'];
    $reason = $d['reason'];
    $boundDeviceName = null;
    if (is_array($device) && ($device['ok'] ?? true) === false) {
        $allowed = false;
        $reason = $device['reason'] ?? 'device_mismatch';
        $boundDeviceName = $device['boundDeviceName'] ?? null;
    }
    return [
        'user'               => Users::summary($user),
        'allowed'            => $allowed,
        'status'             => $user['status'],
        'admin'              => Users::isAdmin($config, $user['email']),
        'command'            => $user['command'] ?? null,
        'plan'               => $d['plan'],
        'reason'             => $reason,
        'boundDeviceName'    => $boundDeviceName,
        'trialEndsAt'        => $d['trialEndsAt'],
        'trialDaysLeft'      => $d['trialDaysLeft'],
        'subscriptionStatus' => $d['subscriptionStatus'],
        'currentPeriodEnd'   => $d['currentPeriodEnd'],
        'planAmountInr'      => $d['planAmountInr'],
    ];
};
$issueSession = function (array $identity, ?array $device = null) use ($store, $config, $tokens, $accessPayload) {
    $user = Users::signIn($store, $config, $identity);
    // Bind this machine on first sign-in, or verify it matches on later ones.
    $verdict = Users::checkDevice($store, $config, $user['email'], $device['id'] ?? null, $device['name'] ?? null);
    $user = $verdict['user'] ?? $user;
    $token = $tokens->sign(
        ['email' => $user['email'], 'sub' => $user['googleSub'] ?? ($identity['sub'] ?? '')],
        $config['sessionTtlMs']
    );
    Http::json(array_merge(['token' => $token], $accessPayload($user, $verdict)));
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
        $issueSession($identity, is_array($body['device'] ?? null) ? $body['device'] : null);
    }

    if ($method === 'POST' && $path === '/auth/google/code') {
        $body = $jsonBody();
        $identity = $google->exchangeCode(
            (string) ($body['code'] ?? ''),
            (string) ($body['codeVerifier'] ?? ''),
            (string) ($body['redirectUri'] ?? '')
        );
        $issueSession($identity, is_array($body['device'] ?? null) ? $body['device'] : null);
    }

    if ($method === 'GET' && $path === '/me') {
        $payload = $tokens->verify($bearer());
        if (!$payload || empty($payload['email'])) {
            Http::error('invalid or expired session', 401);
        }
        $current = Users::touch($store, $payload['email']);
        if (!$current) {
            Http::json(['user' => ['email' => $payload['email'], 'status' => 'unknown'], 'allowed' => false, 'status' => 'unknown', 'reason' => 'unknown']);
        }
        // Verify the heartbeat is coming from the bound machine (device id in a header,
        // since this is a GET). A mismatch locks the tool with reason 'device_mismatch'.
        $verdict = Users::checkDevice($store, $config, $current['email'], $getHeader('X-Device-Id'), $getHeader('X-Device-Name'));
        $current = $verdict['user'] ?? $current;
        Http::json($accessPayload($current, $verdict));
    }

    // Self-service: move this account's single seat to the calling machine.
    if ($method === 'POST' && $path === '/device/claim') {
        $payload = $tokens->verify($bearer());
        if (!$payload || empty($payload['email'])) {
            Http::error('invalid or expired session', 401);
        }
        $body = $jsonBody();
        $device = is_array($body['device'] ?? null) ? $body['device'] : $body;
        $user = Users::claimDevice($store, $config, (string) $payload['email'], $device['id'] ?? null, $device['name'] ?? null);
        $verdict = Users::checkDevice($store, $config, $user['email'], $device['id'] ?? null, $device['name'] ?? null);
        Http::json($accessPayload($verdict['user'] ?? $user, $verdict));
    }

    // --- billing (Razorpay monthly subscription) ---

    // Start (or restart) a Pro subscription for the signed-in user.
    if ($method === 'POST' && $path === '/billing/subscribe') {
        $payload = $tokens->verify($bearer());
        if (!$payload || empty($payload['email'])) {
            Http::error('invalid or expired session', 401);
        }
        $email = strtolower((string) $payload['email']);
        $current = $store->getUser($email);
        if (!$current) {
            Http::error('account not found', 404);
        }
        $sub = $razorpay->createSubscription($email);
        Users::setSubscription($store, $email, [
            'subscriptionId'     => $sub['id'],
            'subscriptionStatus' => $sub['status'] ?? 'created',
        ]);
        Http::json([
            'subscriptionId' => $sub['id'],
            'keyId'          => $razorpay->keyId(),
            'planAmountInr'  => (int) ($config['planAmountInr'] ?? 999),
            'payUrl'         => '/pay?sub=' . rawurlencode($sub['id']),
        ]);
    }

    // Hosted Razorpay checkout page (opened in the app's payment window).
    if ($method === 'GET' && $path === '/pay') {
        header('Content-Type: text/html; charset=utf-8');
        $sub = isset($_GET['sub']) ? (string) $_GET['sub'] : '';
        $keyId = $razorpay->keyId();
        $amount = (int) ($config['planAmountInr'] ?? 999);
        if ($keyId === '' || $sub === '') {
            echo '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d10;color:#e6e8ec;padding:40px">Payments are not configured yet.</body>';
            exit;
        }
        echo render_pay_page($sub, $keyId, $amount);
        exit;
    }

    // Verify a completed subscription payment. No session needed: the Razorpay
    // signature proves authenticity, and the subscription id maps to the user.
    if ($method === 'POST' && $path === '/billing/verify') {
        $body = $jsonBody();
        $paymentId = (string) ($body['razorpay_payment_id'] ?? '');
        $subId = (string) ($body['razorpay_subscription_id'] ?? '');
        $sig = (string) ($body['razorpay_signature'] ?? '');
        if (!$razorpay->verifyPaymentSignature($paymentId, $subId, $sig)) {
            Http::error('invalid payment signature', 400);
        }
        $user = Users::findBySubscription($store, $subId);
        if (!$user) {
            Http::error('subscription not recognised', 404);
        }
        $periodEnd = null;
        $remote = $razorpay->getSubscription($subId);
        if ($remote && !empty($remote['current_end'])) {
            $periodEnd = gmdate('Y-m-d\TH:i:s\Z', (int) $remote['current_end']);
        } else {
            $periodEnd = gmdate('Y-m-d\TH:i:s\Z', time() + 31 * 86400);
        }
        $updated = Users::setSubscription($store, $user['email'], [
            'plan'               => 'pro',
            'subscriptionStatus' => 'active',
            'currentPeriodEnd'   => $periodEnd,
        ]);
        $store->appendAudit(['ts' => Users::nowIso(), 'actor' => $user['email'], 'action' => 'subscribe:active', 'target' => $user['email'], 'detail' => 'sub=' . $subId]);
        Http::json(['ok' => true, 'allowed' => Users::isAllowed($config, $updated), 'currentPeriodEnd' => $periodEnd]);
    }

    // Razorpay webhook: keep subscription status/expiry current across renewals
    // and cancellations. Configure it in the Razorpay dashboard to POST here.
    if ($method === 'POST' && $path === '/billing/webhook') {
        $raw = file_get_contents('php://input') ?: '';
        if (!$razorpay->verifyWebhook($raw, $getHeader('X-Razorpay-Signature'))) {
            Http::error('invalid webhook signature', 400);
        }
        $event = json_decode($raw, true);
        $entity = $event['payload']['subscription']['entity'] ?? null;
        if (is_array($entity) && !empty($entity['id'])) {
            $user = Users::findBySubscription($store, (string) $entity['id']);
            if ($user) {
                $evName = (string) ($event['event'] ?? '');
                $fields = ['subscriptionStatus' => $entity['status'] ?? null];
                if (in_array($evName, ['subscription.charged', 'subscription.activated', 'subscription.authenticated'], true)) {
                    $fields['plan'] = 'pro';
                    $fields['subscriptionStatus'] = 'active';
                    if (!empty($entity['current_end'])) {
                        $fields['currentPeriodEnd'] = gmdate('Y-m-d\TH:i:s\Z', (int) $entity['current_end']);
                    }
                }
                Users::setSubscription($store, $user['email'], $fields);
                $store->appendAudit(['ts' => Users::nowIso(), 'actor' => 'razorpay', 'action' => 'webhook:' . $evName, 'target' => $user['email'], 'detail' => (string) ($entity['status'] ?? '')]);
            }
        }
        Http::json(['ok' => true]);
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
        if ($method === 'POST' && preg_match('#^/users/([^/]+)/reset-device$#', $sub, $m)) {
            $email = strtolower(urldecode($m[1]));
            if (!Google::isEmail($email)) {
                throw new HttpException('invalid target email', 400);
            }
            $user = Users::resetDevice($store, $actor, $email);
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

// Standalone Razorpay checkout page served by GET /pay. Kept as its own function
// (top-level, so PHP hoists it) and has no PHP open tags inside, so the
// single-file build inlines it cleanly.
function render_pay_page(string $sub, string $keyId, int $amount): string
{
    $subJs = json_encode($sub);
    $keyJs = json_encode($keyId);
    $amtText = number_format($amount);
    return <<<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>A2solveX Pro - Payment</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:'Segoe UI',system-ui,sans-serif;
    background:radial-gradient(800px 500px at 50% -10%,rgba(80,222,163,.16),transparent 60%),#0b0d10;color:#e6e8ec}
  .card{width:min(420px,92vw);padding:34px 30px;border:1px solid rgba(255,255,255,.08);border-radius:20px;
    background:rgba(20,24,28,.92);box-shadow:0 30px 80px rgba(0,0,0,.55);text-align:center}
  .logo{font-size:26px;font-weight:800;letter-spacing:.02em;margin-bottom:6px}
  .logo span{color:#50dea3}
  .price{font-size:15px;color:#9aa2ad;margin:0 0 10px}
  .price b{color:#e6e8ec}
  #status{margin:18px 0 0;font-size:14px;color:#aab1bb;min-height:20px}
  .btn{margin-top:16px;display:none;width:100%;height:48px;border:0;border-radius:12px;background:#50dea3;
    color:#07140e;font-size:14px;font-weight:700;cursor:pointer}
  .ok{color:#50dea3;font-weight:700}
</style></head>
<body>
  <div class="card">
    <div class="logo">A2solve<span>X</span> Pro</div>
    <p class="price">&#8377;<b>{$amtText}</b> / month &middot; cancel anytime</p>
    <div id="status">Opening secure Razorpay checkout&hellip;</div>
    <button class="btn" id="retry">Open checkout</button>
  </div>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <script>
    var SUB={$subJs}, KEY={$keyJs};
    var statusEl=document.getElementById('status'), retry=document.getElementById('retry');
    function setStatus(t,ok){statusEl.textContent=t;statusEl.className=ok?'ok':'';}
    function openCheckout(){
      retry.style.display='none';
      var rzp=new Razorpay({
        key:KEY, subscription_id:SUB, name:'A2solveX Pro', description:'Monthly subscription',
        theme:{color:'#50dea3'},
        handler:function(resp){
          setStatus('Verifying payment…',false);
          fetch('/billing/verify',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({razorpay_payment_id:resp.razorpay_payment_id,
              razorpay_subscription_id:resp.razorpay_subscription_id||SUB,
              razorpay_signature:resp.razorpay_signature})})
            .then(function(r){return r.json();})
            .then(function(d){ if(d&&d.ok){ setStatus('✓ Payment successful — you can close this window.',true); document.title='PAID'; }
              else { setStatus('Verification failed: '+((d&&d.error)||'unknown'),false); retry.style.display='block'; } })
            .catch(function(){ setStatus('Network error during verification.',false); retry.style.display='block'; });
        },
        modal:{ondismiss:function(){ setStatus('Checkout closed. You can reopen it below.',false); retry.style.display='block'; }}
      });
      rzp.open();
    }
    retry.addEventListener('click',openCheckout);
    window.addEventListener('load',openCheckout);
  </script>
</body></html>
HTML;
}
