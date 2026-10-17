<?php
// Tiny HTTP helpers for the front controller.

class HttpException extends Exception
{
    public int $status;
    public function __construct(string $message, int $status)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

final class Http
{
    public static function json($data, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode($data);
        exit;
    }

    public static function error(string $message, int $status): void
    {
        self::json(['error' => $message], $status);
    }

    // Constant-time comparison for tokens.
    public static function safeEquals(string $a, string $b): bool
    {
        return hash_equals($a, $b);
    }
}
