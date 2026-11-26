<?php
/** Offline registration-invitation contract, durable recovery and admission tests. */
declare(strict_types=1);
require_once __DIR__ . '/../server/member_service.php';
require_once __DIR__ . '/test-member-device-fixture.php';

function inviteCheck(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function inviteError(callable $run, string $expected): void
{
    try { $run(); } catch (MemberError $error) {
        inviteCheck($error->errorCode === $expected, "Expected $expected, got " . $error->errorCode);
        return;
    }
    throw new RuntimeException("Expected $expected");
}

$scratch = sys_get_temp_dir() . '/yunqiao-invite-test-' . bin2hex(random_bytes(8));
$config = ['enabled' => true, 'origin' => 'https://example.test', 'adminKey' => 'test-only-invite-admin',
    'secret' => str_repeat('test-only-invite-ledger-', 2), 'dataDir' => $scratch];
$credentials = ['installationId' => 'invite-fixture-installation', 'installationProof' => hash('sha256', 'test-installation-proof')];
$generated = [];
$keys = [];
$behavior = 'success';
$duringPost = null;
$receiptOverride = null;
$deniedKey = null;
$transport = static function ($method, $path, $headers, $body) use (&$generated, &$keys, &$behavior, &$duringPost, &$receiptOverride, &$deniedKey): array {
    inviteCheck(in_array('x-api-key: test-only-invite-admin', $headers, true), 'Server uses its own admin header');
    if ($method === 'GET' && preg_match('#^/admin/redeem-codes/(\d+)$#D', $path, $m)) {
        inviteCheck($body === null, 'Reconciliation is read-only');
        return ['status' => 200, 'body' => ['code' => 0, 'data' => $receiptOverride ?? $generated[(int)$m[1]]]];
    }
    inviteCheck($method === 'POST' && $path === '/admin/redeem-codes/generate', 'Unexpected call');
    inviteCheck($body === ['count' => 1, 'type' => 'invitation', 'value' => 0], 'Only one registration code, zero credit');
    $header = array_values(preg_grep('/^Idempotency-Key: yq-invite-[a-f0-9]{32}$/D', $headers));
    inviteCheck(count($header) === 1 && !isset($keys[$header[0]]), 'Exactly one submit per durable reservation');
    if ($behavior === 'denied') {
        $deniedKey = $header[0];
        return ['status' => 403, 'body' => ['code' => 'FORBIDDEN']];
    }
    if ($behavior === 'unknown-denial') return ['status' => 403, 'body' => null];
    if ($deniedKey !== null) {
        inviteCheck($deniedKey === $header[0], 'Retry explicit denial with original reservation');
        $deniedKey = null;
    }
    $keys[$header[0]] = true;
    $id = count($generated) + 1;
    $record = ['id' => $id, 'code' => 'INV-FIXTURE-' . $id, 'type' => 'invitation', 'value' => 0,
        'status' => 'unused', 'used_by' => null, 'used_at' => null];
    $generated[$id] = $record;
    if ($duringPost) $duringPost();
    if ($behavior === 'timeout') throw new MemberError('UPSTREAM_UNAVAILABLE', 'fixture response lost', 503);
    return ['status' => 200, 'body' => ['code' => 0, 'data' => $behavior === 'wrong-type'
        ? [array_replace($record, ['type' => 'balance'])] : [$record]]];
};
$service = new MemberService($config, $transport);
$fetch = static function (string $device, ?array $identity = null) use (&$service, $credentials): array {
    $identity ??= $credentials;
    $payload = memberDeviceTestBody($service, 'invite', $identity, $device);
    return $service->handle('invite', $payload, $identity);
};

try {
    inviteError(fn() => $service->handle('invite', [], $credentials), 'DEVICE_PROOF_INVALID');
    inviteCheck($generated === [], 'Missing proof must not allocate upstream');
    $duringPost = static function () use ($fetch, $service): void {
        inviteError(fn() => $fetch('device-a'), 'INVITE_REVIEW_REQUIRED');
        $pending = $service->adminPendingInvitations();
        inviteCheck(count($pending) === 1, 'Reservation must commit before network');
        inviteError(fn() => $service->adminRecoverInvitation($pending[0]['requestId'], 1), 'INVITE_IN_PROGRESS');
    };
    $first = $fetch('device-a');
    $duringPost = null;
    inviteCheck($first === ['ok' => true, 'inviteCode' => 'INV-FIXTURE-1'], 'Return only the invitation code');
    $generated[1]['status'] = 'used';
    $generated[1]['used_by'] = 77;
    $service = new MemberService($config, $transport);
    inviteCheck($fetch('device-a', ['installationId' => 'another-installation-fixture', 'installationProof' => hash('sha256','another-proof')]) === $first,
        'Same device still gets original code after use, restart and change of installation');
    inviteCheck($fetch('device-b')['inviteCode'] !== $first['inviteCode'] && count($generated) === 2, 'Different authorized device gets a different code');
    $behavior = 'timeout';
    inviteError(fn() => $fetch('device-c'), 'INVITE_REVIEW_REQUIRED');
    $pending = $service->adminPendingInvitations();
    inviteCheck(count($pending) === 1 && $pending[0]['lastError'] === 'UPSTREAM_UNAVAILABLE', 'Indeterminate response preserved');
    $request = $pending[0]['requestId'];
    $behavior = 'success';
    $service = new MemberService($config, $transport);
    inviteError(fn() => $fetch('device-c'), 'INVITE_REVIEW_REQUIRED');
    inviteCheck(count($generated) === 3, 'Lost response never triggers second generation');
    inviteError(fn() => $service->adminRecoverInvitation($request, 2), 'INVITE_ALREADY_ASSIGNED');
    $receiptOverride = array_replace($generated[3], ['id' => 33]);
    inviteError(fn() => $service->adminRecoverInvitation($request, 3), 'INVITE_RECEIPT_INVALID');
    $receiptOverride = array_replace($generated[3], ['value' => 10]);
    inviteError(fn() => $service->adminRecoverInvitation($request, 3), 'INVITE_RECEIPT_INVALID');
    $receiptOverride = null;
    $service->adminRecoverInvitation($request, 3);
    $service->adminRecoverInvitation($request, 3);
    inviteCheck($fetch('device-c')['inviteCode'] === $generated[3]['code'] && !$service->adminPendingInvitations(), 'Recovered code returned on original device');
    $behavior = 'wrong-type';
    inviteError(fn() => $fetch('device-d'), 'INVITE_REVIEW_REQUIRED');
    inviteCheck($service->adminPendingInvitations()[0]['lastError'] === 'INVITE_RECEIPT_INVALID', 'Non-invitation receipt is never exposed');
    inviteError(fn() => $fetch('device-d'), 'INVITE_REVIEW_REQUIRED');
    inviteCheck(count($generated) === 4, 'Exactly one generate for each of four authorized devices');
    $behavior = 'denied';
    inviteError(fn() => $fetch('device-e'), 'INVITE_UPSTREAM_DENIED');
    $denied = array_values(array_filter($service->adminPendingInvitations(), static fn(array $row): bool => $row['lastError'] === 'INVITE_UPSTREAM_DENIED'));
    inviteCheck(count($denied) === 1, 'Explicit permission denial retained');
    inviteError(fn() => $service->adminRecoverInvitation($denied[0]['requestId'], 2), 'INVITE_RETRY_REQUIRED');
    $behavior = 'success';
    inviteCheck($fetch('device-e')['inviteCode'] === 'INV-FIXTURE-5' && $deniedKey === null, 'Completed same booking after permissions repaired');
    $behavior = 'unknown-denial';
    inviteError(fn() => $fetch('device-f'), 'INVITE_REVIEW_REQUIRED');
    $behavior = 'success';
    inviteError(fn() => $fetch('device-f'), 'INVITE_REVIEW_REQUIRED');
    inviteCheck(count($generated) === 5, 'Unknown intermediary error never permits a second submit');
    unset($service);
    $db = new PDO('sqlite:' . $scratch . '/members.sqlite');
    $db->exec('DROP TABLE member_invitations');
    unset($db);
    $service = new MemberService($config, $transport);
    inviteError(fn() => $service->adminPendingInvitations(), 'STORAGE_UNAVAILABLE');
    echo "Registration invitations: fixed device assignment, admission, concurrent and ambiguous issuance, reconciliation and damaged ledger passed.\n";
} finally {
    $service = null;
    unset($fetch, $duringPost, $transport, $db);
    gc_collect_cycles();
    if (is_dir($scratch)) {
        foreach (new DirectoryIterator($scratch) as $file) if ($file->isFile()) unlink($file->getPathname());
        rmdir($scratch);
    }
}
