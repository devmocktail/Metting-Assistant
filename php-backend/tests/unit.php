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

// --- Users domain ---
$config = cfg();
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

echo "\nRESULT  $pass passed, $fail failed\n";
exit($fail > 0 ? 1 : 0);
