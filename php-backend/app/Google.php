<?php
// Resolves a client token into a verified identity {sub, email, name}.
// - stub mode: "stub:<email>[:<name>]" (local/testing only).
// - google mode, raw id token: verified via Google's tokeninfo endpoint.
// - google mode, code exchange: the loopback auth code is exchanged at Google's
//   token endpoint (with the server-held client secret); the returned id_token
//   comes straight from Google over TLS, so its claims are decoded and the
//   audience checked.
final class Google
{
    private array $config;

    public function __construct(array $config)
    {
        $this->config = $config;
    }

    public static function isEmail(string $email): bool
    {
        return $email !== '' && (bool) filter_var($email, FILTER_VALIDATE_EMAIL);
    }

    private static function b64urlDecode(string $str): string
    {
        $pad = strlen($str) % 4;
        if ($pad) {
            $str .= str_repeat('=', 4 - $pad);
        }
        return base64_decode(strtr($str, '-_', '+/')) ?: '';
    }

    private static function decodeJwtPayload(string $jwt): ?array
    {
        $parts = explode('.', $jwt);
        if (count($parts) < 2) {
            return null;
        }
        $payload = json_decode(self::b64urlDecode($parts[1]), true);
        return is_array($payload) ? $payload : null;
    }

    public function resolveStub(string $token): array
    {
        if (strncmp($token, 'stub:', 5) !== 0) {
            throw new HttpException('stub auth expects a "stub:" token', 400);
        }
        $rest = substr($token, 5);
        $sep = strpos($rest, ':');
        $email = strtolower(trim($sep === false ? $rest : substr($rest, 0, $sep)));
        $name = $sep === false ? '' : trim(substr($rest, $sep + 1));
        if (!self::isEmail($email)) {
            throw new HttpException('invalid stub email', 400);
        }
        return ['sub' => 'stub:' . $email, 'email' => $email, 'name' => $name !== '' ? $name : $email];
    }

    public function resolveIdToken(string $idToken): array
    {
        if ($idToken === '') {
            throw new HttpException('idToken required', 400);
        }
        [$code, $body] = $this->curl('https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($idToken), null);
        if ($code !== 200) {
            throw new HttpException('Google token verification failed', 401);
        }
        $p = json_decode($body, true);
        return $this->identityFromClaims(is_array($p) ? $p : []);
    }

    public function exchangeCode(string $code, string $codeVerifier, string $redirectUri): array
    {
        if ($this->config['googleClientId'] === '' || $this->config['googleClientSecret'] === '') {
            throw new HttpException('server missing Google client credentials', 500);
        }
        if ($code === '' || $codeVerifier === '' || $redirectUri === '') {
            throw new HttpException('code, codeVerifier, redirectUri required', 400);
        }
        $post = http_build_query([
            'code'          => $code,
            'code_verifier' => $codeVerifier,
            'redirect_uri'  => $redirectUri,
            'client_id'     => $this->config['googleClientId'],
            'client_secret' => $this->config['googleClientSecret'],
            'grant_type'    => 'authorization_code',
        ]);
        [$status, $body] = $this->curl('https://oauth2.googleapis.com/token', $post);
        if ($status !== 200) {
            throw new HttpException('Google token exchange failed', 401);
        }
        $data = json_decode($body, true);
        if (!is_array($data) || empty($data['id_token'])) {
            throw new HttpException('Google token response missing id_token', 401);
        }
        $claims = self::decodeJwtPayload($data['id_token']);
        return $this->identityFromClaims(is_array($claims) ? $claims : []);
    }

    private function identityFromClaims(array $p): array
    {
        if (empty($p['email'])) {
            throw new HttpException('Google token missing email', 401);
        }
        if (($p['aud'] ?? '') !== $this->config['googleClientId']) {
            throw new HttpException('Google token audience mismatch', 401);
        }
        $verified = $p['email_verified'] ?? true;
        if ($verified === false || $verified === 'false') {
            throw new HttpException('Google email not verified', 403);
        }
        return [
            'sub'   => (string) ($p['sub'] ?? ''),
            'email' => strtolower((string) $p['email']),
            'name'  => (string) ($p['name'] ?? ''),
        ];
    }

    private function curl(string $url, ?string $body): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/x-www-form-urlencoded']);
        }
        $resp = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [$status, $resp === false ? '' : $resp];
    }
}
