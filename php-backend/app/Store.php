<?php
// Persists the whole state ({users, audit}) as one JSON row, in MySQL (Hostinger)
// or SQLite (local testing). Mirrors the Node store: small data cached in memory,
// full document written on each change.
final class Store
{
    private PDO $pdo;
    private bool $sqlite;
    private string $key = 'meeting-assistant:state:v1';
    private array $state = ['users' => [], 'audit' => []];

    public function __construct(array $config)
    {
        if (($config['store'] ?? 'sqlite') === 'mysql') {
            $m = $config['mysql'];
            $dsn = "mysql:host={$m['host']};port={$m['port']};dbname={$m['database']};charset=utf8mb4";
            $this->pdo = new PDO($dsn, $m['user'], $m['password'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
            $this->sqlite = false;
        } else {
            $path = $config['sqlitePath'];
            if (!is_dir(dirname($path))) {
                @mkdir(dirname($path), 0775, true);
            }
            $this->pdo = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $this->sqlite = true;
        }
    }

    public function init(): void
    {
        $type = $this->sqlite ? 'TEXT' : 'LONGTEXT';
        $this->pdo->exec("CREATE TABLE IF NOT EXISTS app_state (k VARCHAR(190) NOT NULL PRIMARY KEY, v {$type})");
        $stmt = $this->pdo->prepare('SELECT v FROM app_state WHERE k = ? LIMIT 1');
        $stmt->execute([$this->key]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row && isset($row['v']) && $row['v'] !== null) {
            $decoded = json_decode($row['v'], true);
            if (is_array($decoded)) {
                $this->state = [
                    'users' => isset($decoded['users']) && is_array($decoded['users']) ? $decoded['users'] : [],
                    'audit' => isset($decoded['audit']) && is_array($decoded['audit']) ? $decoded['audit'] : [],
                ];
            }
        }
    }

    private function save(): void
    {
        $v = json_encode($this->state);
        $sql = $this->sqlite
            ? 'INSERT INTO app_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
            : 'INSERT INTO app_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)';
        $this->pdo->prepare($sql)->execute([$this->key, $v]);
    }

    private static function norm(string $email): string
    {
        return strtolower(trim($email));
    }

    public function getUser(string $email): ?array
    {
        return $this->state['users'][self::norm($email)] ?? null;
    }

    public function listUsers(): array
    {
        return array_values($this->state['users']);
    }

    public function upsertUser(string $email, callable $mutator): ?array
    {
        $key = self::norm($email);
        $existing = $this->state['users'][$key] ?? null;
        $next = $mutator($existing);
        if ($next === null) {
            return null;
        }
        $next['email'] = $key;
        $this->state['users'][$key] = $next;
        $this->save();
        return $next;
    }

    public function deleteUser(string $email): bool
    {
        $key = self::norm($email);
        if (!isset($this->state['users'][$key])) {
            return false;
        }
        unset($this->state['users'][$key]);
        $this->save();
        return true;
    }

    public function appendAudit(array $entry): void
    {
        $this->state['audit'][] = $entry;
        if (count($this->state['audit']) > 1000) {
            $this->state['audit'] = array_slice($this->state['audit'], -1000);
        }
        $this->save();
    }

    public function listAudit(int $limit = 200): array
    {
        $a = $this->state['audit'];
        $n = max(0, min($limit, count($a)));
        return array_reverse(array_slice($a, count($a) - $n));
    }
}
