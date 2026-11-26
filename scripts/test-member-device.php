<?php
/** Exercise the public membership entry points with an isolated ledger and a local transport. */
declare(strict_types=1);
require_once __DIR__ . '/../server/member_service.php';
require_once __DIR__ . '/test-member-device-fixture.php';

function deviceCheck(bool $ok, string $message): void
{
    if (!$ok) throw new RuntimeException($message);
}
function deviceError(string $expected, callable $run): void
{
    try { $run(); }
    catch (MemberError $e) {
        deviceCheck($e->errorCode === $expected, 'Expected ' . $expected . ', got ' . $e->errorCode);
        return;
    }
    throw new RuntimeException('Expected ' . $expected);
}

$directory = sys_get_temp_dir() . '/yunqiao-device-proof-' . bin2hex(random_bytes(8));
$config = ['enabled' => true, 'origin' => 'https://members.example.test', 'adminKey' => 'offline-fixture-admin',
    'secret' => bin2hex(random_bytes(32)), 'dataDir' => $directory];
$issuedInvites = 0;
$credits = 0;
$transport = static function (string $method, string $path, array $headers, ?array $body) use (&$issuedInvites, &$credits): array {
    $ok = static fn(array $data): array => ['status' => 200, 'body' => ['code' => 0, 'data' => $data]];
    if ($path === '/auth/me') {
        foreach ($headers as $header) if (preg_match('/^Authorization: Bearer fixture-user-([1-9]+)$/D', $header, $match)) {
            return $ok(['id' => (int)$match[1], 'status' => 'active', 'balance' => 0, 'email' => 'fixture@example.test']);
        }
    }
    if (str_starts_with($path, '/admin/redeem-codes?')) return $ok(['items' => [], 'total' => 0]);
    if ($path === '/admin/redeem-codes/create-and-redeem') {
        ++$credits;
        return $ok(['redeem_code' => ['id' => 20, 'code' => $body['code'], 'type' => 'balance', 'value' => $body['value'],
            'used_by' => $body['user_id'], 'status' => 'used']]);
    }
    if ($path === '/admin/redeem-codes/generate') {
        ++$issuedInvites;
        return $ok([['id' => $issuedInvites, 'code' => 'INV-FIXTURE-' . $issuedInvites, 'type' => 'invitation', 'value' => 0,
            'status' => 'unused', 'used_by' => null, 'used_at' => null, 'expires_at' => null]]);
    }
    throw new RuntimeException('Unexpected fixture operation: ' . $path);
};
$service = new MemberService($config, $transport);
$creds = ['installationId' => 'test-member-device-install-one', 'installationProof' => hash('sha256', 'install-one')];
$creds2 = ['installationId' => 'test-member-device-install-two', 'installationProof' => hash('sha256', 'install-two')];
$key = memberDeviceTestKey('device-one');
$otherKey = memberDeviceTestKey('device-two');
$otherKey['deviceId'] = $key['deviceId']; // A separately generated local key for the same machine after reinstall.
$challenge = static function (array $device, array $credentials, string $purpose = 'invite') use ($service): array {
    return $service->handle('device-challenge', ['deviceId' => $device['deviceId'], 'publicKey' => $device['publicKey'], 'purpose' => $purpose], $credentials);
};
$proof = static function (array $device, array $credentials, string $purpose = 'invite') use ($challenge): array {
    return memberDeviceTestSign($device, $purpose, $credentials, $challenge($device, $credentials, $purpose)['challenge']);
};

deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $challenge($key, $creds));
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', [], $creds));
$service->adminAuthorizeDevice($key['deviceId'], $key['keyId']);
$service->adminAuthorizeDevice($key['deviceId'], $key['keyId']);
$list = $service->adminListDevices();
deviceCheck(count($list) === 1 && $list[0]['active'] && $list[0]['deviceHash'] !== $key['deviceId'], 'Device approval must be idempotent and use a server-side digest');
deviceError('DEVICE_KEY_CONFLICT', fn() => $service->adminAuthorizeDevice($key['deviceId'], $otherKey['keyId']));
deviceError('DEVICE_KEY_CONFLICT', fn() => $service->adminAuthorizeDevice(hash('sha256','other-id'), $key['keyId']));
$signed = $proof($key, $creds);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $signed, $creds2));
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $signed + ['platform' => 'desktop'], $creds));
$wrong = memberDeviceTestSign($otherKey, 'invite', $creds, $signed['challenge']);
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $service->handle('invite', $wrong, $creds));
$wrong['publicKey'] = $key['publicKey'];
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $wrong, $creds));
deviceCheck($issuedInvites === 0, 'Rejected inputs must not allocate an invitation');
$code = $service->handle('invite', $signed, $creds)['inviteCode'];
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $signed, $creds));
deviceCheck($service->handle('invite', $proof($key, $creds2), $creds2)['inviteCode'] === $code && $issuedInvites === 1, 'Installation reset must reuse the invitation');

$expired = $proof($key, $creds);
$db = new PDO('sqlite:' . $directory . '/members.sqlite');
$q = $db->prepare('UPDATE member_device_challenges SET expires_at=? WHERE nonce_hash=?');
$q->execute([time(), hash('sha256', $expired['challenge'])]);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $expired, $creds));
$bound = $service->handle('bind', ['accessToken' => 'fixture-user-1'], $creds);
$session = $creds + ['sessionToken' => $bound['sessionToken']];
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('claim', [], $session));
$invite = $proof($key, $creds);
$wrongPurpose = memberDeviceTestSign($key, 'claim', $session, $invite['challenge']);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('claim', $wrongPurpose, $session));
deviceCheck($credits === 0, 'Only a valid claim challenge may create a grant');
$claim = $proof($key, $session, 'claim');
deviceCheck($service->handle('claim', $claim, $session)['gift']['status'] === 'claimed', 'Valid device proof may claim');
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('claim', $claim, $session));
$secondBound = $service->handle('bind', ['accessToken' => 'fixture-user-2'], $creds2);
$session2 = $creds2 + ['sessionToken' => $secondBound['sessionToken']];
$wrongSession = memberDeviceTestSign($key, 'claim', $session2, $challenge($key, $session, 'claim')['challenge']);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('claim', $wrongSession, $session2));
deviceError('DEVICE_ALREADY_CLAIMED', fn() => $service->handle('claim', $proof($key, $session2, 'claim'), $session2));
deviceCheck($credits === 1, 'Second installation/account cannot credit the same approved device again');

$outstanding = $proof($key, $creds);
$service->adminRevokeDevice($list[0]['deviceHash']);
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $service->handle('invite', $outstanding, $creds));
$service->adminAuthorizeDevice($key['deviceId'], $key['keyId']);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $outstanding, $creds));
$service->adminRevokeDevice($list[0]['deviceHash']);
$service->adminAuthorizeDevice($key['deviceId'], $otherKey['keyId']);
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $challenge($key, $creds));
deviceCheck($service->handle('invite', $proof($otherKey, $creds2), $creds2)['inviteCode'] === $code, 'Approved replacement key must see original invitation');
deviceError('DEVICE_ALREADY_CLAIMED', fn() => $service->handle('claim', $proof($otherKey, $session2, 'claim'), $session2));
deviceCheck($issuedInvites === 1 && $credits === 1, 'Key rotation cannot reset the invitation or monetary ledger');
$limited = false;
for ($i = 0; $i <= 40; ++$i) {
    try { $challenge($otherKey, $creds); }
    catch (MemberError $e) { deviceCheck($e->errorCode === 'RATE_LIMITED', 'Expected device limit'); $limited = true; break; }
}
deviceCheck($limited, 'Device challenge production must be bounded');
$db->exec('DROP TABLE member_devices');
deviceError('STORAGE_UNAVAILABLE', fn() => (new MemberService($config, $transport))->adminListDevices());
echo "Passed device authorization, request binding, replay, expiry, revocation, key rotation, invitation reuse, gift deduplication, rate limits and damaged-ledger checks.\n";
