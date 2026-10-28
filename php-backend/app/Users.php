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
        return self::accessDetail($config, $user)['allowed'];
    }

    // Single source of truth for access + the reason it is (not) granted, so the
    // app can show "trial ended" / "activate Pro" instead of a generic lock.
    // Access = not banned/pending AND (admin OR within trial OR active Pro sub).
    // Legacy approved users (no 'plan' field) keep full access, unchanged.
    public static function accessDetail(array $config, ?array $user): array
    {
        $out = [
            'allowed'            => false,
            'reason'             => null,
            'plan'               => null,
            'trialEndsAt'        => null,
            'trialDaysLeft'      => null,
            'subscriptionStatus' => null,
            'currentPeriodEnd'   => null,
            'planAmountInr'      => (int) ($config['planAmountInr'] ?? 999),
        ];
        if (!$user) {
            $out['reason'] = 'unknown';
            return $out;
        }
        $out['plan'] = $user['plan'] ?? null;
        $out['subscriptionStatus'] = $user['subscriptionStatus'] ?? null;
        $out['currentPeriodEnd'] = $user['currentPeriodEnd'] ?? null;

        if (self::isAdmin($config, $user['email'])) {
            $out['allowed'] = true;
            return $out;
        }
        $status = $user['status'] ?? '';
        if ($status === 'banned') { $out['reason'] = 'banned'; return $out; }
        if ($status === 'pending') { $out['reason'] = 'pending'; return $out; }
        if ($status !== 'approved') { $out['reason'] = $status !== '' ? $status : 'unknown'; return $out; }

        // Approved. Legacy records (created before plans existed) stay fully allowed.
        if (!array_key_exists('plan', $user)) {
            $out['allowed'] = true;
            return $out;
        }

        $plan = $user['plan'] ?: 'trial';
        if ($plan === 'pro') {
            $active = ($user['subscriptionStatus'] ?? '') === 'active';
            $end = isset($user['currentPeriodEnd']) ? strtotime((string) $user['currentPeriodEnd']) : 0;
            $ok = $active && ($end === 0 || time() <= $end + 2 * 86400); // 2-day grace past period end
            $out['allowed'] = $ok;
            if (!$ok) { $out['reason'] = 'payment_required'; }
            return $out;
        }

        // Trial.
        $start = isset($user['trialStartedAt']) ? strtotime((string) $user['trialStartedAt'])
            : (isset($user['createdAt']) ? strtotime((string) $user['createdAt']) : time());
        $days = (int) ($config['trialDays'] ?? 7);
        $endTs = $start + $days * 86400;
        $out['trialEndsAt'] = gmdate('Y-m-d\TH:i:s\Z', $endTs);
        $out['trialDaysLeft'] = max(0, (int) ceil(($endTs - time()) / 86400));
        if (time() < $endTs) {
            $out['allowed'] = true;
        } else {
            $out['reason'] = 'trial_expired';
        }
        return $out;
    }

    // Find the user currently tied to a Razorpay subscription id (verify/webhook).
    public static function findBySubscription(Store $store, string $subscriptionId): ?array
    {
        if ($subscriptionId === '') {
            return null;
        }
        foreach ($store->listUsers() as $u) {
            if (($u['subscriptionId'] ?? '') === $subscriptionId) {
                return $u;
            }
        }
        return null;
    }

    // Apply subscription fields (from verify / webhook) to a user.
    public static function setSubscription(Store $store, string $email, array $fields): ?array
    {
        $now = self::nowIso();
        return $store->upsertUser($email, function ($existing) use ($fields, $now) {
            if (!$existing) {
                return null;
            }
            foreach (['subscriptionId', 'subscriptionStatus', 'currentPeriodEnd', 'plan'] as $k) {
                if (array_key_exists($k, $fields)) {
                    $existing[$k] = $fields[$k];
                }
            }
            $existing['updatedAt'] = $now;
            return $existing;
        });
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
            'plan'       => $u['plan'] ?? null,
            'subscriptionStatus' => $u['subscriptionStatus'] ?? null,
            'currentPeriodEnd'   => $u['currentPeriodEnd'] ?? null,
            // Device binding (for the admin panel): the bound machine + any blocked
            // second-machine attempt (a sign of shared credentials).
            'device'      => (isset($u['device']) && is_array($u['device']))
                ? ['name' => $u['device']['name'] ?? '', 'boundAt' => $u['device']['boundAt'] ?? null, 'lastSeenAt' => $u['device']['lastSeenAt'] ?? null]
                : null,
            'deviceAlert' => $u['deviceAlert'] ?? null,
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

        $selfServe = (bool) ($config['selfServe'] ?? true);
        $user = $store->upsertUser($email, function ($existing) use ($identity, $admin, $now, &$created, $email, $selfServe) {
            if (!$existing) {
                $created = true;
                return [
                    'email'          => $email,
                    'name'           => $identity['name'] ?? '',
                    'googleSub'      => $identity['sub'] ?? '',
                    // Self-serve: new accounts are approved straight onto a free trial.
                    // With SELF_SERVE=false they wait for an admin (legacy behaviour).
                    'status'         => ($admin || $selfServe) ? 'approved' : 'pending',
                    'createdAt'      => $now,
                    'updatedAt'      => $now,
                    'lastSeenAt'     => $now,
                    'approvedBy'     => $admin ? 'system:admin-email' : ($selfServe ? 'system:self-serve' : null),
                    'notes'          => '',
                    // Everyone starts on the free trial; Pro is an upgrade via Razorpay.
                    'plan'           => 'trial',
                    'trialStartedAt' => $now,
                    'subscriptionId' => null,
                    'subscriptionStatus' => null,
                    'currentPeriodEnd'   => null,
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

    // Device binding (one account → one machine) to stop credential sharing.
    //
    // Binds the account to the first machine that signs in; afterwards a different
    // machine is denied access (reason 'device_mismatch') and recorded so the admin
    // can see the sharing attempt. Returns the (possibly updated) user plus a verdict:
    //   ['user'=>array, 'ok'=>bool, 'reason'=>?string, 'boundDeviceName'=>?string]
    // No-ops (ok=true) when binding is disabled, no device id is sent (older client),
    // or the account is an admin — admins are exempt so you can always manage.
    public static function checkDevice(Store $store, array $config, string $email, ?string $deviceId, ?string $deviceName): array
    {
        $key = strtolower(trim($email));
        $user = $store->getUser($key);
        $out = ['user' => $user, 'ok' => true, 'reason' => null, 'boundDeviceName' => null];
        if (!$user) {
            return $out;
        }
        if (!($config['deviceBinding'] ?? true)) {
            return $out;
        }
        $deviceId = is_string($deviceId) ? trim($deviceId) : '';
        if ($deviceId === '' || self::isAdmin($config, $key)) {
            return $out;
        }

        $name = (is_string($deviceName) && $deviceName !== '') ? substr($deviceName, 0, 120) : 'Unknown device';
        $now = self::nowIso();
        $bound = (isset($user['device']) && is_array($user['device'])) ? $user['device'] : null;

        if (!$bound || empty($bound['id'])) {
            // First machine for this account → bind it.
            $user = $store->upsertUser($key, function ($e) use ($deviceId, $name, $now) {
                if (!$e) {
                    return null;
                }
                $e['device'] = ['id' => $deviceId, 'name' => $name, 'boundAt' => $now, 'lastSeenAt' => $now];
                $e['deviceAlert'] = null;
                return $e;
            });
            $store->appendAudit(['ts' => $now, 'actor' => $key, 'action' => 'device:bind', 'target' => $key, 'detail' => $name]);
            $out['user'] = $user;
            return $out;
        }

        if (hash_equals((string) $bound['id'], $deviceId)) {
            // Same machine → just refresh its last-seen stamp.
            $user = $store->upsertUser($key, function ($e) use ($now) {
                if (!$e || empty($e['device'])) {
                    return $e;
                }
                $e['device']['lastSeenAt'] = $now;
                return $e;
            });
            $out['user'] = $user;
            return $out;
        }

        // A different machine → deny, and record the attempt (shared-credentials signal).
        $user = $store->upsertUser($key, function ($e) use ($deviceId, $name, $now) {
            if (!$e) {
                return null;
            }
            $prev = (isset($e['deviceAlert']) && is_array($e['deviceAlert'])) ? $e['deviceAlert'] : null;
            $count = ($prev && ($prev['id'] ?? '') === $deviceId) ? ((int) ($prev['count'] ?? 1) + 1) : 1;
            $e['deviceAlert'] = ['id' => $deviceId, 'name' => $name, 'at' => $now, 'count' => $count];
            return $e;
        });
        $store->appendAudit(['ts' => $now, 'actor' => $key, 'action' => 'device:blocked', 'target' => $key, 'detail' => $name]);
        $out['user'] = $user;
        $out['ok'] = false;
        $out['reason'] = 'device_mismatch';
        $out['boundDeviceName'] = $bound['name'] ?? 'another device';
        return $out;
    }

    // Self-service "use on this device instead": re-bind the account to the calling
    // machine. Throttled by DEVICE_MOVE_COOLDOWN_MS so it can't be used to hand an
    // account back and forth between two people all day.
    public static function claimDevice(Store $store, array $config, string $email, ?string $deviceId, ?string $deviceName): array
    {
        $key = strtolower(trim($email));
        $user = $store->getUser($key);
        if (!$user) {
            throw new HttpException('account not found', 404);
        }
        $deviceId = is_string($deviceId) ? trim($deviceId) : '';
        if ($deviceId === '') {
            throw new HttpException('device id required', 400);
        }
        $bound = (isset($user['device']) && is_array($user['device'])) ? $user['device'] : null;
        $already = $bound && !empty($bound['id']) && hash_equals((string) $bound['id'], $deviceId);

        $cooldownMs = (int) ($config['deviceMoveCooldownMs'] ?? 0);
        $movedAt = isset($user['deviceMovedAt']) ? strtotime((string) $user['deviceMovedAt']) : 0;
        if (!$already && $cooldownMs > 0 && $movedAt > 0) {
            $elapsed = time() - $movedAt;
            if ($elapsed < $cooldownMs / 1000) {
                $retryMin = (int) ceil(($cooldownMs / 1000 - $elapsed) / 60);
                throw new HttpException('This account was moved to another device recently. You can move it again in about ' . $retryMin . ' minutes.', 429);
            }
        }

        $name = (is_string($deviceName) && $deviceName !== '') ? substr($deviceName, 0, 120) : 'Unknown device';
        $now = self::nowIso();
        $user = $store->upsertUser($key, function ($e) use ($deviceId, $name, $now, $already) {
            if (!$e) {
                return null;
            }
            $e['device'] = ['id' => $deviceId, 'name' => $name, 'boundAt' => $now, 'lastSeenAt' => $now];
            $e['deviceAlert'] = null;
            if (!$already) {
                $e['deviceMovedAt'] = $now;
            }
            return $e;
        });
        $store->appendAudit(['ts' => $now, 'actor' => $key, 'action' => 'device:move', 'target' => $key, 'detail' => $name]);
        return $user;
    }

    // Admin: forget the bound device so the next sign-in re-binds (e.g. the user got
    // a new laptop). Also clears the move cooldown and any blocked-device alert.
    public static function resetDevice(Store $store, string $actorEmail, string $targetEmail): array
    {
        $email = strtolower(trim($targetEmail));
        if (!Google::isEmail($email)) {
            throw new HttpException('invalid target email', 400);
        }
        $now = self::nowIso();
        $user = $store->upsertUser($email, function ($e) use ($now) {
            if (!$e) {
                return null;
            }
            $e['device'] = null;
            $e['deviceAlert'] = null;
            $e['deviceMovedAt'] = null;
            $e['updatedAt'] = $now;
            return $e;
        });
        if ($user) {
            $store->appendAudit(['ts' => $now, 'actor' => strtolower(trim($actorEmail)), 'action' => 'device:reset', 'target' => $email, 'detail' => '']);
        }
        return $user ?? [];
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
