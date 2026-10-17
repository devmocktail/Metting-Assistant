<?php
// Domain logic: sign-in upsert, admin approve/ban/unban, audit. Mirrors the Node
// backend's users.js. Status is the single source of truth for access.
final class Users
{
    const STATUSES = ['pending', 'approved', 'banned'];

    public static function isAdmin(array $config, string $email): bool
    {
        return in_array(strtolower(trim($email)), $config['adminEmails'], true);
    }

    public static function isAllowed(array $config, ?array $user): bool
    {
        if (!$user) {
            return false;
        }
        if (self::isAdmin($config, $user['email'])) {
            return true;
        }
        return ($user['status'] ?? '') === 'approved';
    }

    public static function summary(?array $u): ?array
    {
        if (!$u) {
            return null;
        }
        return [
            'email'      => $u['email'],
            'name'       => $u['name'] ?? '',
            'status'     => $u['status'],
            'createdAt'  => $u['createdAt'] ?? null,
            'updatedAt'  => $u['updatedAt'] ?? null,
            'lastSeenAt' => $u['lastSeenAt'] ?? null,
            'approvedBy' => $u['approvedBy'] ?? null,
            'notes'      => $u['notes'] ?? '',
            'command'    => $u['command'] ?? null,
        ];
    }

    public static function nowIso(): string
    {
        $t = microtime(true);
        return gmdate('Y-m-d\TH:i:s', (int) $t) . sprintf('.%03dZ', (int) round(($t - floor($t)) * 1000) % 1000);
    }

    // After a verified identity: create (pending, or approved for admins) or
    // update the record and refresh lastSeen.
    public static function signIn(Store $store, array $config, array $identity): array
    {
        $email = strtolower(trim($identity['email']));
        if (!Google::isEmail($email)) {
            throw new HttpException('invalid email', 400);
        }
        $admin = self::isAdmin($config, $email);
        $now = self::nowIso();
        $created = false;

        $user = $store->upsertUser($email, function ($existing) use ($identity, $admin, $now, &$created, $email) {
            if (!$existing) {
                $created = true;
                return [
                    'email'      => $email,
                    'name'       => $identity['name'] ?? '',
                    'googleSub'  => $identity['sub'] ?? '',
                    'status'     => $admin ? 'approved' : 'pending',
                    'createdAt'  => $now,
                    'updatedAt'  => $now,
                    'lastSeenAt' => $now,
                    'approvedBy' => $admin ? 'system:admin-email' : null,
                    'notes'      => '',
                ];
            }
            $updated = $existing;
            $updated['name'] = ($identity['name'] ?? '') !== '' ? $identity['name'] : ($existing['name'] ?? '');
            $updated['googleSub'] = ($identity['sub'] ?? '') !== '' ? $identity['sub'] : ($existing['googleSub'] ?? '');
            $updated['lastSeenAt'] = $now;
            $updated['updatedAt'] = $now;
            if ($admin && ($updated['status'] ?? '') !== 'approved') {
                $updated['status'] = 'approved';
                $updated['approvedBy'] = 'system:admin-email';
            }
            return $updated;
        });

        if ($created) {
            $store->appendAudit(['ts' => $now, 'actor' => $email, 'action' => 'signup', 'target' => $email, 'detail' => 'status=' . $user['status']]);
        }
        return $user;
    }

    public static function touch(Store $store, string $email): ?array
    {
        $key = strtolower(trim($email));
        if (!$store->getUser($key)) {
            return null;
        }
        $now = self::nowIso();
        return $store->upsertUser($key, function ($existing) use ($now) {
            if (!$existing) {
                return null;
            }
            $existing['lastSeenAt'] = $now;
            return $existing;
        });
    }

    public static function setStatus(Store $store, array $config, string $actorEmail, string $targetEmail, string $status, ?string $notes = null): array
    {
        $email = strtolower(trim($targetEmail));
        if (!Google::isEmail($email)) {
            throw new HttpException('invalid target email', 400);
        }
        if (!in_array($status, self::STATUSES, true)) {
            throw new HttpException('status must be one of ' . implode(', ', self::STATUSES), 400);
        }
        $now = self::nowIso();
        $actor = strtolower(trim($actorEmail));

        $user = $store->upsertUser($email, function ($existing) use ($status, $now, $actor, $notes, $email) {
            if (!$existing) {
                return [
                    'email'      => $email,
                    'name'       => '',
                    'googleSub'  => '',
                    'status'     => $status,
                    'createdAt'  => $now,
                    'updatedAt'  => $now,
                    'lastSeenAt' => null,
                    'approvedBy' => $status === 'approved' ? $actor : null,
                    'notes'      => $notes ?? '',
                    'command'    => null,
                ];
            }
            $existing['status'] = $status;
            $existing['updatedAt'] = $now;
            $existing['approvedBy'] = $status === 'approved' ? $actor : ($existing['approvedBy'] ?? null);
            if ($notes !== null) {
                $existing['notes'] = $notes;
            }
            // A status change cancels any pending remote-uninstall command.
            $existing['command'] = null;
            return $existing;
        });

        $store->appendAudit(['ts' => $now, 'actor' => $actor, 'action' => 'set:' . $status, 'target' => $email, 'detail' => $notes ?? '']);
        return $user;
    }

    // Admin: flag a user's device to self-remove on its next heartbeat; also bans
    // them so access is cut immediately.
    public static function uninstall(Store $store, array $config, string $actorEmail, string $targetEmail): array
    {
        $email = strtolower(trim($targetEmail));
        if (!Google::isEmail($email)) {
            throw new HttpException('invalid target email', 400);
        }
        $now = self::nowIso();
        $user = $store->upsertUser($email, function ($existing) use ($email, $now) {
            $base = $existing ?? ['email' => $email, 'name' => '', 'googleSub' => '', 'createdAt' => $now, 'lastSeenAt' => null, 'approvedBy' => null, 'notes' => ''];
            $base['status'] = 'banned';
            $base['command'] = 'uninstall';
            $base['updatedAt'] = $now;
            return $base;
        });
        $store->appendAudit(['ts' => $now, 'actor' => strtolower(trim($actorEmail)), 'action' => 'uninstall', 'target' => $email, 'detail' => '']);
        return $user;
    }

    public static function remove(Store $store, string $actorEmail, string $targetEmail): bool
    {
        $email = strtolower(trim($targetEmail));
        $existed = $store->deleteUser($email);
        if ($existed) {
            $store->appendAudit(['ts' => self::nowIso(), 'actor' => strtolower(trim($actorEmail)), 'action' => 'delete', 'target' => $email, 'detail' => '']);
        }
        return $existed;
    }

    public static function listUsers(Store $store, array $config): array
    {
        $list = array_map(function ($u) use ($config) {
            $s = self::summary($u);
            $s['admin'] = self::isAdmin($config, $u['email']);
            $s['allowed'] = self::isAllowed($config, $u);
            return $s;
        }, $store->listUsers());
        usort($list, fn ($a, $b) => strcmp((string) ($b['updatedAt'] ?? ''), (string) ($a['updatedAt'] ?? '')));
        return $list;
    }
}
