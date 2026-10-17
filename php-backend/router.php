<?php
// Router for the PHP built-in server (local testing only):
//   php -S 127.0.0.1:8000 -c dev-php.ini router.php
// Serves existing static files (the admin page) directly; everything else goes
// to the front controller. Hostinger uses .htaccess for the same effect.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = __DIR__ . $path;
if ($path !== '/' && is_file($file)) {
    return false; // let the built-in server serve the asset
}
if (is_dir($file)) {
    $index = rtrim($file, '/') . '/index.html';
    if (is_file($index)) {
        header('Content-Type: text/html');
        readfile($index);
        return true;
    }
}
require __DIR__ . '/index.php';
