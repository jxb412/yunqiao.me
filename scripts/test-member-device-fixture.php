<?php
/** Offline signing fixture. Children in concurrency tests reuse the same temporary key. */
declare(strict_types=1);

function memberDeviceTestKey(string $name): array
{
    static $keys = [];
    if (isset($keys[$name])) return $keys[$name];
    $dir = getenv('YUNQIAO_MEMBER_TEST_KEY_DIRECTORY');
    if (!$dir) {
        $dir = sys_get_temp_dir() . '/yunqiao-device-test-' . bin2hex(random_bytes(12));
        if (!mkdir($dir, 0700)) throw new RuntimeException('Cannot create fixture directory');
        putenv('YUNQIAO_MEMBER_TEST_KEY_DIRECTORY=' . $dir);
        register_shutdown_function(static function () use ($dir): void {
            foreach (glob($dir . '/*.pem') as $file) unlink($file);
            rmdir($dir);
        });
    }
    $id = hash('sha256', 'fixture-device:' . $name);
    $file = fopen($dir . '/' . $id . '.pem', 'c+b');
    if (!$file || !flock($file, LOCK_EX)) throw new RuntimeException('Cannot lock fixture key');
    try {
        $pem = stream_get_contents($file);
        if ($pem === '') {
            $options = ['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1'];
            $bundled = dirname(PHP_BINARY) . '/extras/ssl/openssl.cnf';
            if (is_file($bundled)) $options['config'] = $bundled;
            $key = openssl_pkey_new($options);
            if (!$key || !openssl_pkey_export($key, $pem, null, $options) || fwrite($file, $pem) !== strlen($pem) || !fflush($file)) {
                throw new RuntimeException('Cannot generate fixture key');
            }
        } else {
            $key = openssl_pkey_get_private($pem);
        }
        $details = openssl_pkey_get_details($key);
        $publicKey = preg_replace('/-----[^-]+-----|\s/', '', $details['key']);
        return $keys[$name] = ['deviceId' => $id, 'publicKey' => $publicKey, 'keyId' => hash('sha256', base64_decode($publicKey, true)), 'privateKey' => $key];
    } finally { flock($file, LOCK_UN); fclose($file); }
}

function memberDeviceTestSign(array $key, string $purpose, array $credentials, string $challenge): array
{
    $message = implode("\n", ['yunqiao-member-device-v1', $purpose, $key['deviceId'], $credentials['installationId'],
        hash('sha256', $credentials['sessionToken'] ?? ''), $challenge]);
    if (!openssl_sign($message, $signature, $key['privateKey'], OPENSSL_ALGO_SHA256)) throw new RuntimeException('Fixture signing failed');
    return ['deviceId' => $key['deviceId'], 'publicKey' => $key['publicKey'], 'challenge' => $challenge, 'signature' => base64_encode($signature)];
}

function memberDeviceTestBody(MemberService $service, string $purpose, array $credentials, ?string $deviceName = null): array
{
    $key = memberDeviceTestKey($deviceName ?? $credentials['installationId']);
    $service->adminAuthorizeDevice($key['deviceId'], $key['keyId']);
    $issued = $service->handle('device-challenge', ['purpose' => $purpose, 'deviceId' => $key['deviceId'], 'publicKey' => $key['publicKey']], $credentials);
    return memberDeviceTestSign($key, $purpose, $credentials, $issued['challenge']);
}

function memberDeviceTestClaim(MemberService $service, array $credentials, ?string $deviceName = null): array
{
    return $service->handle('claim', memberDeviceTestBody($service, 'claim', $credentials, $deviceName), $credentials);
}
