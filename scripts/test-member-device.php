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

deviceCheck($service->publicConfig()['deviceAutoApprove'] === true, 'First-time signers can enroll by default');
$initial = $service->adminDeviceApprovalPolicy();
$beforePause = $proof($key, $creds);
deviceCheck(!$service->adminListDevices(), 'Issuing a challenge must never enroll a device');
$manual = $service->adminSaveDeviceApprovalPolicy(false, $initial['revision']);
deviceCheck($manual === ['autoApprove' => false, 'revision' => 2]
    && (new MemberService($config, $transport))->publicConfig()['deviceAutoApprove'] === false, 'Manual policy persists');
deviceError('DEVICE_POLICY_CONFLICT', fn() => $service->adminSaveDeviceApprovalPolicy(true, $initial['revision']));
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $challenge($key, $creds));
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $service->handle('invite', $beforePause, $creds));
$service->adminSaveDeviceApprovalPolicy(true, $manual['revision']);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $beforePause, $creds));
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', [], $creds));
$winning = $proof($key, $creds);
$competing = $proof($otherKey, $creds);
$mismatched = memberDeviceTestSign($otherKey, 'invite', $creds, $winning['challenge']);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $mismatched, $creds));
$fake = array_replace($winning, ['signature' => $mismatched['signature']]);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $fake, $creds));
deviceCheck(!$service->adminListDevices() && $issuedInvites === 0, 'Invalid or crossed proofs cannot enroll or contact the upstream');
$code = $service->handle('invite', $winning, $creds)['inviteCode'];
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $service->handle('invite', $competing, $creds));
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $winning, $creds));
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
deviceCheck($issuedInvites === 1, 'Rejected inputs must not allocate another invitation');
deviceCheck($service->handle('invite', $signed, $creds)['inviteCode'] === $code, 'Existing device keeps its invite');
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
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $challenge($key, $creds));
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $challenge($otherKey, $creds));
$service->adminAuthorizeDevice($key['deviceId'], $key['keyId']);
deviceError('DEVICE_PROOF_INVALID', fn() => $service->handle('invite', $outstanding, $creds));
$service->adminRevokeDevice($list[0]['deviceHash']);
$service->adminAuthorizeDevice($key['deviceId'], $otherKey['keyId']);
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $challenge($key, $creds));
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $challenge(array_replace($key, ['deviceId' => hash('sha256','unrelated-id')]), $creds));
deviceCheck($service->handle('invite', $proof($otherKey, $creds2), $creds2)['inviteCode'] === $code, 'Approved replacement key must see original invitation');
deviceError('DEVICE_ALREADY_CLAIMED', fn() => $service->handle('claim', $proof($otherKey, $session2, 'claim'), $session2));
deviceCheck($issuedInvites === 1 && $credits === 1, 'Key rotation cannot reset the invitation or monetary ledger');
$limited = false;
for ($i = 0; $i <= 40; ++$i) {
    try { $challenge($otherKey, $creds); }
    catch (MemberError $e) { deviceCheck($e->errorCode === 'RATE_LIMITED', 'Expected device limit'); $limited = true; break; }
}
deviceCheck($limited, 'Device challenge production must be bounded');

// Enrollment limits count newly admitted devices, not failed proofs or existing clients.
$submit = static function (array $device, string $ip) use ($service, $creds): array {
    $response = $service->handle('device-challenge', ['deviceId' => $device['deviceId'], 'publicKey' => $device['publicKey'], 'purpose' => 'invite'], $creds, $ip);
    return $service->handle('invite', memberDeviceTestSign($device, 'invite', $creds, $response['challenge']), $creds, $ip);
};
for ($i = 1; $i <= 5; ++$i) $submit(memberDeviceTestKey('new-' . $i), '192.0.2.10');
$firstNew = memberDeviceTestKey('new-1');
$sixth = memberDeviceTestKey('new-6');
deviceError('RATE_LIMITED', fn() => $submit($sixth, '192.0.2.10'));
deviceCheck(count($service->adminListDevices()) === 6, 'Exhausted enrollment allowance cannot reserve a device');
$submit($firstNew, '192.0.2.10');
$submit($sixth, '192.0.2.11');
$policy = $service->adminDeviceApprovalPolicy();
$service->adminSaveDeviceApprovalPolicy(false, $policy['revision']);
$submit($sixth, '192.0.2.10');
deviceError('DEVICE_APPROVAL_REQUIRED', fn() => $submit(memberDeviceTestKey('manual-new'), '192.0.2.11'));

// Model a v1 installation with real invitations, a paid grant, and a revoked key.
$revokedHash = $service->adminListDevices()[0]['deviceHash'];
$service->adminRevokeDevice($revokedHash);
$snapshot = static fn(string $table): array => $db->query("SELECT * FROM $table ORDER BY 1")->fetchAll(PDO::FETCH_ASSOC);
$original = array_map($snapshot, ['member_devices', 'welcome_grants', 'member_invitations']);
$db->exec("DROP TABLE member_device_challenges;
    DROP TABLE member_device_keys;
    DELETE FROM member_meta WHERE key='device_approval_policy';
    UPDATE member_meta SET value='1' WHERE key='device_proof_version'");
$oldChallengeSchema = 'CREATE TABLE member_device_challenges (
                nonce_hash TEXT PRIMARY KEY, device_hash TEXT NOT NULL REFERENCES member_devices(device_hash),
                context_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)';
$db->exec(str_replace("\n", "\r\n", str_replace("\r\n", "\n", $oldChallengeSchema)));
$q = $db->prepare('INSERT INTO member_device_challenges VALUES(?,?,?,?)');
$q->execute([hash('sha256','obsolete'), $revokedHash, hash('sha256','old context'), time() + 120]);
$migrated = new MemberService($config, $transport);
deviceCheck($migrated->publicConfig()['deviceAutoApprove'], 'Migration initializes policy to automatic');
deviceCheck($db->query("SELECT value FROM member_meta WHERE key='device_proof_version'")->fetchColumn() === '2', 'Migration upgrades schema');
deviceCheck($original === array_map($snapshot, ['member_devices','welcome_grants','member_invitations']), 'Migration must preserve revoked keys, active keys, grants and assigned invitations exactly');
deviceCheck(count($snapshot('member_device_keys')) === count($original[0]) && !$snapshot('member_device_challenges'), 'Old keys remembered; obsolete challenges invalidated');
$migrated->adminSaveDeviceApprovalPolicy(false, 1);
$db->exec("DELETE FROM member_meta WHERE key='device_approval_policy'");
deviceError('STORAGE_UNAVAILABLE', fn() => (new MemberService($config, $transport))->publicConfig());
$db->exec('DROP TABLE member_devices');
deviceError('STORAGE_UNAVAILABLE', fn() => (new MemberService($config, $transport))->adminListDevices());
echo "Passed automatic and manual enrollment, signed key binding, policy switch, replay, expiry, revocation, key rotation, invitation reuse, gift deduplication, enrollment limits, migration and damaged-ledger checks.\n";
