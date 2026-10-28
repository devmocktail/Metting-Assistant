<?php
// Razorpay subscriptions (monthly ₹999 plan). All secret-key calls happen here,
// server-side; the client only ever sees the publishable key id and a
// subscription id. Signature checks prove a payment/webhook really came from
// Razorpay without trusting the client.
final class Razorpay
{
    private string $keyId;
    private string $keySecret;
    private string $planId;
    private string $webhookSecret;

    public function __construct(array $config)
    {
        $this->keyId = (string) ($config['razorpayKeyId'] ?? '');
        $this->keySecret = (string) ($config['razorpayKeySecret'] ?? '');
        $this->planId = (string) ($config['razorpayPlanId'] ?? '');
        $this->webhookSecret = (string) ($config['razorpayWebhookSecret'] ?? '');
    }

    // True only when enough is configured to create a subscription.
    public function configured(): bool
    {
        return $this->keyId !== '' && $this->keySecret !== '' && $this->planId !== '';
    }

    public function keyId(): string
    {
        return $this->keyId;
    }

    // Create a monthly subscription for the configured plan, tagged with the email.
    public function createSubscription(string $email): array
    {
        if (!$this->configured()) {
            throw new HttpException('payments not configured', 503);
        }
        $payload = json_encode([
            'plan_id'         => $this->planId,
            'total_count'     => 12,   // authorise up to 12 monthly charges
            'quantity'        => 1,
            'customer_notify' => 1,
            'notes'           => ['email' => $email],
        ]);
        [$status, $body] = $this->curl('POST', 'https://api.razorpay.com/v1/subscriptions', $payload);
        $data = json_decode($body, true);
        if ($status < 200 || $status >= 300 || !is_array($data) || empty($data['id'])) {
            $msg = (is_array($data) && isset($data['error']['description'])) ? $data['error']['description'] : 'could not create subscription';
            throw new HttpException('Razorpay: ' . $msg, 502);
        }
        return $data;
    }

    public function getSubscription(string $id): ?array
    {
        if (!$this->configured() || $id === '') {
            return null;
        }
        [$status, $body] = $this->curl('GET', 'https://api.razorpay.com/v1/subscriptions/' . rawurlencode($id), null);
        $data = json_decode($body, true);
        return ($status >= 200 && $status < 300 && is_array($data)) ? $data : null;
    }

    // For subscriptions, Razorpay signs: payment_id + '|' + subscription_id.
    public function verifyPaymentSignature(string $paymentId, string $subscriptionId, string $signature): bool
    {
        if ($this->keySecret === '' || $paymentId === '' || $subscriptionId === '' || $signature === '') {
            return false;
        }
        $expected = hash_hmac('sha256', $paymentId . '|' . $subscriptionId, $this->keySecret);
        return hash_equals($expected, $signature);
    }

    public function verifyWebhook(string $rawBody, string $signature): bool
    {
        if ($this->webhookSecret === '' || $signature === '') {
            return false;
        }
        $expected = hash_hmac('sha256', $rawBody, $this->webhookSecret);
        return hash_equals($expected, $signature);
    }

    private function curl(string $method, string $url, ?string $json): array
    {
        $ch = curl_init($url);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 20,
            CURLOPT_USERPWD        => $this->keyId . ':' . $this->keySecret,
            CURLOPT_HTTPAUTH       => CURLAUTH_BASIC,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        ];
        if ($method === 'POST') {
            $opts[CURLOPT_POST] = true;
            if ($json !== null) {
                $opts[CURLOPT_POSTFIELDS] = $json;
            }
        } elseif ($method !== 'GET') {
            $opts[CURLOPT_CUSTOMREQUEST] = $method;
            if ($json !== null) {
                $opts[CURLOPT_POSTFIELDS] = $json;
            }
        }
        curl_setopt_array($ch, $opts);
        $resp = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [$status, $resp === false ? '' : $resp];
    }
}
