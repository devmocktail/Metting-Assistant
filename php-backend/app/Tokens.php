<?php
// HMAC-SHA256 signed session tokens (same scheme as the Node backend):
// base64url(JSON payload) + "." + base64url(HMAC). The user's live status is
// always re-read from the store, never trusted from the token.
final class Tokens
{
    private string $secret;

    public function __construct(string $secret)
    {
        if ($secret === '') {
            throw new InvalidArgumentException('token secret required');
        }
        $this->secret = $secret;
    }

    private static function b64url(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private static function b64urlDecode(string $str): string
    {
        $pad = strlen($str) % 4;
        if ($pad) {
            $str .= str_repeat('=', 4 - $pad);
        }
        return base64_decode(strtr($str, '-_', '+/')) ?: '';
    }

    private static function nowMs(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    public function sign(array $payload, int $ttlMs): string
    {
        $now = self::nowMs();
        $payload['iat'] = $now;
        $payload['exp'] = $now + $ttlMs;
        $enc = self::b64url(json_encode($payload));
        $sig = self::b64url(hash_hmac('sha256', $enc, $this->secret, true));
        return $enc . '.' . $sig;
    }

    public function verify(?string $token): ?array
    {
        if ($token === null || $token === '') {
            return null;
        }
        $dot = strpos($token, '.');
        if ($dot === false || $dot === 0 || $dot === strlen($token) - 1) {
            return null;
        }
        $enc = substr($token, 0, $dot);
        $sig = substr($token, $dot + 1);
        $expected = self::b64url(hash_hmac('sha256', $enc, $this->secret, true));
        if (!hash_equals($expected, $sig)) {
            return null;
        }
        $payload = json_decode(self::b64urlDecode($enc), true);
        if (!is_array($payload)) {
            return null;
        }
        if (isset($payload['exp']) && is_int($payload['exp']) && $payload['exp'] > 0 && self::nowMs() > $payload['exp']) {
            return null;
        }
        return $payload;
    }
}
