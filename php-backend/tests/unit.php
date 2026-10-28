<?php
// Unit tests for the PHP backend logic (run with the dev ini, uses SQLite).
require __DIR__ . '/../app/Http.php';
require __DIR__ . '/../app/Config.php';
require __DIR__ . '/../app/Tokens.php';
require __DIR__ . '/../app/Store.php';
require __DIR__ . '/../app/Google.php';
require __DIR__ . '/../app/Users.php';

$pass = 0;
$fail = 0;
function check(string $name, bool $cond): void
{
    global $pass, $fail;
    if ($cond) { $pass++; echo "PASS  $name\n"; }
    else { $fail++; echo "FAIL  $name\n"; }
}
function tmpSqlite(): string
{
    return sys_get_temp_dir() . '/maa-' . uniqid() . '.sqlite';
}
function cfg(array $over = []): array
{
    return array_merge([
        'authMode' => 'stub', 'googleClientId' => 'cid', 'googleClientSecret' => 'sec',
        'sessionSecret' => 'test-secret', 'adminToken' => 'test-admin', 'adminEmails' => ['admin@corp.com'],
        'sessionTtlMs' => 10000, 'heartbeatIntervalMs' => 120000, 'offlineGraceMs' => 600000,
        'store' => 'sqlite', 'mysql' => [], 'sqlitePath' => tmpSqlite(), 'devAuthSecret' => '',
    ], $over);
}

// --- Tokens ---
$tok = new Tokens('s');
$t = $tok->sign(['email' => 'a@b.com'], 10000);
$p = $tok->verify($t);
check('token round trip', $p && $p['email'] === 'a@b.com' && $p['exp'] > $p['iat']);
check('token tamper rejected', $tok->verify($t . 'x') === null);
check('token wrong secret', (new Tokens('x'))->verify($t) === null);
check('token expired', $tok->verify($tok->sign([], -1)) === null);
check('token junk', $tok->verify('') === null && $tok->verify('abc') === null && $tok->verify('a.') === null);

// --- Store (SQLite) ---
$c = cfg();
$store = new Store($c);
$store->init();
check('store empty', count($store->listUsers()) === 0);
$store->upsertUser('A@B.com', fn ($e) => ['status' => 'pending']);
$u = $store->getUser('a@b.com');
check('store upsert + normalize', $u && $u['status'] === 'pending' && $u['email'] === 'a@b.com');
$store->appendAudit(['ts' => 't', 'action' => 'x']);
check('store audit', count($store->listAudit(5)) === 1);
$store2 = new Store($c); // same sqlite path
$store2->init();
check('store persists across instances', $store2->getUser('a@b.com')['status'] === 'pending');

// --- Users domain (legacy admin-approval mode) ---
$config = cfg(['selfServe' => false]);
$s = new Store($config);
$s->init();
$user = Users::signIn($s, $config, ['sub' => '1', 'email' => 'Sales@Corp.com', 'name' => 'Sales']);
check('signin new user pending', $user['status'] === 'pending' && $user['email'] === 'sales@corp.com' && !Users::isAllowed($config, $user));
$admin = Users::signIn($s, $config, ['sub' => '2', 'email' => 'admin@corp.com', 'name' => 'Boss']);
check('admin auto-approved', $admin['status'] === 'approved' && Users::isAllowed($config, $admin));
Users::setStatus($s, $config, 'admin@corp.com', 'sales@corp.com', 'approved');
check('approve makes allowed', Users::isAllowed($config, $s->getUser('sales@corp.com')));
Users::setStatus($s, $config, 'admin@corp.com', 'sales@corp.com', 'banned');
check('ban locks', !Users::isAllowed($config, $s->getUser('sales@corp.com')));
Users::setStatus($s, $config, 'admin@corp.com', 'vip@corp.com', 'approved');
$vip = Users::signIn($s, $config, ['sub' => '9', 'email' => 'vip@corp.com', 'name' => '']);
check('pre-approve then signin allowed', $vip['status'] === 'approved');
check('remove deletes', Users::remove($s, 'admin@corp.com', 'sales@corp.com') === true && $s->getUser('sales@corp.com') === null);
$threw = false;
try { Users::setStatus($s, $config, 'admin@corp.com', 'x@corp.com', 'nope'); } catch (HttpException $e) { $threw = true; }
check('invalid status rejected', $threw);
$list = Users::listUsers($s, $config);
$adminRow = null;
foreach ($list as $row) { if ($row['email'] === 'admin@corp.com') { $adminRow = $row; } }
check('listUsers marks admin+allowed', $adminRow && $adminRow['admin'] === true && $adminRow['allowed'] === true);

// --- Google stub ---
$g = new Google($config);
$id = $g->resolveStub('stub:Foo@Bar.com:Foo Bar');
check('stub resolve parses', $id['email'] === 'foo@bar.com' && $id['name'] === 'Foo Bar' && $id['sub'] === 'stub:foo@bar.com');
check('stub no name defaults', $g->resolveStub('stub:x@y.com')['name'] === 'x@y.com');
$threw2 = false;
try { $g->resolveStub('notstub'); } catch (HttpException $e) { $threw2 = true; }
check('stub bad token rejected', $threw2);
check('isEmail', Google::isEmail('a@b.com') && !Google::isEmail('nope') && !Google::isEmail(''));

// --- Self-serve trial + plans ---
$sc = cfg(['selfServe' => true, 'trialDays' => 7, 'planAmountInr' => 999]);
$ss = new Store($sc);
$ss->init();
$tu = Users::signIn($ss, $sc, ['sub' => 't1', 'email' => 'trial@corp.com', 'name' => 'Trial']);
check('self-serve new user approved+trial', $tu['status'] === 'approved' && ($tu['plan'] ?? '') === 'trial' && Users::isAllowed($sc, $tu));
$td = Users::accessDetail($sc, $tu);
check('trial detail: allowed, 7 days left', $td['allowed'] === true && $td['reason'] === null && $td['trialDaysLeft'] === 7);
$ss->upsertUser('trial@corp.com', function ($e) { $e['trialStartedAt'] = gmdate('Y-m-d\TH:i:s\Z', time() - 10 * 86400); return $e; });
$ed = Users::accessDetail($sc, $ss->getUser('trial@corp.com'));
check('expired trial locked + reason', $ed['allowed'] === false && $ed['reason'] === 'trial_expired');
Users::setSubscription($ss, 'trial@corp.com', ['plan' => 'pro', 'subscriptionStatus' => 'active', 'subscriptionId' => 'sub_1', 'currentPeriodEnd' => gmdate('Y-m-d\TH:i:s\Z', time() + 20 * 86400)]);
$pd = Users::accessDetail($sc, $ss->getUser('trial@corp.com'));
check('pro active allowed', $pd['allowed'] === true && $pd['plan'] === 'pro');
check('findBySubscription maps to user', (Users::findBySubscription($ss, 'sub_1')['email'] ?? '') === 'trial@corp.com');
Users::setSubscription($ss, 'trial@corp.com', ['currentPeriodEnd' => gmdate('Y-m-d\TH:i:s\Z', time() - 5 * 86400)]);
$xd = Users::accessDetail($sc, $ss->getUser('trial@corp.com'));
check('pro past period → payment_required', $xd['allowed'] === false && $xd['reason'] === 'payment_required');
$ss->upsertUser('legacy@corp.com', fn ($e) => ['email' => 'legacy@corp.com', 'status' => 'approved', 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', time() - 100 * 86400)]);
check('legacy approved (no plan) stays allowed', Users::isAllowed($sc, $ss->getUser('legacy@corp.com')));

// --- Device binding (one account = one machine) ---
$dc = cfg(['selfServe' => true, 'deviceBinding' => true, 'deviceMoveCooldownMs' => 0]);
$ds = new Store($dc);
$ds->init();
Users::signIn($ds, $dc, ['sub' => 'd1', 'email' => 'dev@corp.com', 'name' => 'Dev']);
$v1 = Users::checkDevice($ds, $dc, 'dev@corp.com', 'DEVICE-A', 'Laptop-A');
check('device: first machine binds', $v1['ok'] === true && ($ds->getUser('dev@corp.com')['device']['id'] ?? '') === 'DEVICE-A');
check('device: same machine ok', Users::checkDevice($ds, $dc, 'dev@corp.com', 'DEVICE-A', 'Laptop-A')['ok'] === true);
$v3 = Users::checkDevice($ds, $dc, 'dev@corp.com', 'DEVICE-B', 'Laptop-B');
check('device: second machine blocked', $v3['ok'] === false && $v3['reason'] === 'device_mismatch' && $v3['boundDeviceName'] === 'Laptop-A');
check('device: sharing attempt recorded', ($ds->getUser('dev@corp.com')['deviceAlert']['id'] ?? '') === 'DEVICE-B');
Users::signIn($ds, $dc, ['sub' => 'a1', 'email' => 'admin@corp.com', 'name' => 'Boss']);
Users::checkDevice($ds, $dc, 'admin@corp.com', 'ADM-1', 'AdminPC');
check('device: admin exempt from binding', Users::checkDevice($ds, $dc, 'admin@corp.com', 'ADM-2', 'OtherPC')['ok'] === true);
check('device: missing id is a no-op', Users::checkDevice($ds, $dc, 'dev@corp.com', '', '')['ok'] === true);
$dcOff = cfg(['deviceBinding' => false]);
$dsOff = new Store($dcOff); $dsOff->init();
Users::signIn($dsOff, $dcOff, ['sub' => 'o1', 'email' => 'off@corp.com', 'name' => 'Off']);
Users::checkDevice($dsOff, $dcOff, 'off@corp.com', 'X1', 'PC1');
check('device: disabled lets any machine in', Users::checkDevice($dsOff, $dcOff, 'off@corp.com', 'X2', 'PC2')['ok'] === true);
$moved = Users::claimDevice($ds, $dc, 'dev@corp.com', 'DEVICE-B', 'Laptop-B');
check('device: claim moves the seat', ($moved['device']['id'] ?? '') === 'DEVICE-B');
check('device: old machine now blocked', Users::checkDevice($ds, $dc, 'dev@corp.com', 'DEVICE-A', 'Laptop-A')['ok'] === false);
check('device: claimed machine ok', Users::checkDevice($ds, $dc, 'dev@corp.com', 'DEVICE-B', 'Laptop-B')['ok'] === true);
$cdCfg = cfg(['deviceBinding' => true, 'deviceMoveCooldownMs' => 72 * 3600 * 1000]);
$cdS = new Store($cdCfg); $cdS->init();
Users::signIn($cdS, $cdCfg, ['sub' => 'c1', 'email' => 'cd@corp.com', 'name' => 'CD']);
Users::checkDevice($cdS, $cdCfg, 'cd@corp.com', 'M1', 'PC-1');
Users::claimDevice($cdS, $cdCfg, 'cd@corp.com', 'M2', 'PC-2');
$cdThrew = false;
try { Users::claimDevice($cdS, $cdCfg, 'cd@corp.com', 'M3', 'PC-3'); } catch (HttpException $e) { $cdThrew = ($e->status === 429); }
check('device: move cooldown blocks rapid re-move', $cdThrew);
check('device: re-claiming SAME machine ignores cooldown', (Users::claimDevice($cdS, $cdCfg, 'cd@corp.com', 'M2', 'PC-2')['device']['id'] ?? '') === 'M2');
Users::resetDevice($ds, 'admin@corp.com', 'dev@corp.com');
check('device: admin reset clears binding', ($ds->getUser('dev@corp.com')['device'] ?? null) === null);
$rebind = Users::checkDevice($ds, $dc, 'dev@corp.com', 'DEVICE-C', 'Laptop-C');
check('device: rebinds after reset', $rebind['ok'] === true && ($ds->getUser('dev@corp.com')['device']['id'] ?? '') === 'DEVICE-C');
check('summary includes bound device name', (Users::summary($ds->getUser('dev@corp.com'))['device']['name'] ?? '') === 'Laptop-C');

echo "\nRESULT  $pass passed, $fail failed\n";
exit($fail > 0 ? 1 : 0);
