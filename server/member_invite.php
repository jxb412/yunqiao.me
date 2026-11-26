<?php
declare(strict_types=1);

trait MemberInvitations
{
    /** Called with the membership ledger initialization lock held. */
    private function initializeInvitations(PDO $db): void
    {
        $schema = "CREATE TABLE member_invitations (
            device_hash TEXT PRIMARY KEY NOT NULL,
            request_id TEXT NOT NULL UNIQUE,
            requested_at INTEGER NOT NULL,
            upstream_id INTEGER UNIQUE,
            invite_code TEXT UNIQUE,
            last_error TEXT,
            CHECK ((upstream_id IS NULL) = (invite_code IS NULL))
        )";
        $actual = $db->query("SELECT sql FROM sqlite_master WHERE name='member_invitations'")->fetchColumn();
        $version = $db->query("SELECT value FROM member_meta WHERE key='invitation_version'")->fetchColumn();
        if (is_string($actual) && str_replace("\r\n", "\n", $actual) === str_replace("\r\n", "\n", $schema) && $version === '1') return;
        if ($actual !== false || $version !== false) {
            throw new MemberError('STORAGE_UNAVAILABLE', '邀请码账本不完整，请联系管理员恢复备份', 503);
        }
        $db->exec('BEGIN IMMEDIATE');
        try {
            $db->exec($schema);
            $db->exec("INSERT INTO member_meta(key,value) VALUES('invitation_version','1')");
            $db->exec('COMMIT');
        } catch (Throwable $error) { $db->exec('ROLLBACK'); throw $error; }
    }

    private function deviceInvitation(string $deviceHash): array
    {
        $reservation = $this->transaction(function () use ($deviceHash): array {
            if (!$this->execute('SELECT 1 FROM member_devices WHERE device_hash=? AND active=1', [$deviceHash])->fetchColumn()) {
                throw new MemberError('DEVICE_APPROVAL_REQUIRED', '设备授权已撤销', 403);
            }
            $row = $this->execute('SELECT request_id,invite_code,last_error FROM member_invitations WHERE device_hash=?', [$deviceHash])->fetch(PDO::FETCH_ASSOC);
            if ($row) {
                if ($row['invite_code'] !== null) return $row;
                if ($row['last_error'] !== 'INVITE_UPSTREAM_DENIED') throw $this->invitationPending();
                $this->execute('UPDATE member_invitations SET last_error=NULL,requested_at=? WHERE request_id=?', [time(), $row['request_id']]);
                return $row;
            }
            $requestId = bin2hex(random_bytes(16));
            $this->execute('INSERT INTO member_invitations(device_hash,request_id,requested_at) VALUES(?,?,?)', [$deviceHash, $requestId, time()]);
            return ['request_id' => $requestId, 'invite_code' => null];
        });
        if ($reservation['invite_code'] !== null) return ['ok' => true, 'inviteCode' => $reservation['invite_code']];
        $requestId = $reservation['request_id'];
        // The upstream generates random codes. It may have committed even if no response
        // arrives, and its idempotency cache has a limited lifetime. Resubmit only
        // when the previous request was explicitly rejected before issuance.
        try {
            $codes = $this->request('POST', '/admin/redeem-codes/generate',
                ['x-api-key: ' . $this->config['adminKey'], 'Idempotency-Key: yq-invite-' . $requestId],
                ['count' => 1, 'type' => 'invitation', 'value' => 0]);
            if (!array_is_list($codes) || count($codes) !== 1 || !is_array($codes[0])) {
                throw new MemberError('INVITE_RECEIPT_INVALID', '平台返回的邀请码数量异常', 503);
            }
            $this->storeInvitation($requestId, $codes[0]);
            return ['ok' => true, 'inviteCode' => $codes[0]['code']];
        } catch (Throwable $error) {
            $reason = $error instanceof MemberError ? $error->errorCode : 'INVITE_CONFIRMATION_FAILED';
            $this->execute('UPDATE member_invitations SET last_error=? WHERE request_id=? AND invite_code IS NULL', [$reason, $requestId]);
            if ($reason === 'INVITE_UPSTREAM_DENIED') throw $error;
            throw $this->invitationPending();
        }
    }

    private function invitationPending(): MemberError
    {
        return new MemberError('INVITE_REVIEW_REQUIRED', '设备已有邀请码申请，请稍后再查看；若仍未返回，请联系平台管理员核对原申请。', 409);
    }

    private function storeInvitation(string $requestId, array $receipt): void
    {
        $id = $receipt['id'] ?? null;
        $code = $receipt['code'] ?? null;
        if (!is_int($id) || $id <= 0 || !is_string($code) || !preg_match('/^[a-zA-Z0-9_-]{3,128}$/D', $code)
            || ($receipt['type'] ?? null) !== 'invitation' || !in_array($receipt['value'] ?? null, [0, 0.0], true)
            || ($receipt['status'] ?? null) !== 'unused' || !array_key_exists('used_by', $receipt) || $receipt['used_by'] !== null
            || ($receipt['used_at'] ?? null) !== null || ($receipt['expires_at'] ?? null) !== null) {
            throw new MemberError('INVITE_RECEIPT_INVALID', '上游记录必须是未使用且未设置过期时间的注册邀请码', 409);
        }
        $this->transaction(function () use ($requestId, $id, $code): void {
            $row = $this->execute('SELECT * FROM member_invitations WHERE request_id=?', [$requestId])->fetch(PDO::FETCH_ASSOC);
            if (!$row) throw new MemberError('INVITE_REQUEST_NOT_FOUND', '邀请码申请不存在', 404);
            if ($row['invite_code'] !== null) {
                if ((int)$row['upstream_id'] === $id && $row['invite_code'] === $code) return;
                throw new MemberError('INVITE_ALREADY_ASSIGNED', '本设备已有固定邀请码', 409);
            }
            if ($this->execute('SELECT 1 FROM member_invitations WHERE upstream_id=? OR invite_code=?', [$id, $code])->fetchColumn()) {
                throw new MemberError('INVITE_ALREADY_ASSIGNED', '该上游记录已绑定其他设备', 409);
            }
            $this->execute('UPDATE member_invitations SET upstream_id=?,invite_code=?,last_error=NULL WHERE request_id=?', [$id, $code, $requestId]);
        });
    }

    /** Admin session and CSRF are enforced by the caller. No codes or device identifiers in the list. */
    public function adminPendingInvitations(): array
    {
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        return $this->execute('SELECT request_id AS requestId, requested_at AS createdAt, last_error AS lastError
            FROM member_invitations WHERE invite_code IS NULL ORDER BY requested_at LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
    }

    public function adminRecoverInvitation(string $requestId, int $upstreamId): void
    {
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
        if (!preg_match('/^[a-f0-9]{32}$/D', $requestId) || $upstreamId <= 0) {
            throw new MemberError('INVALID_INVITE_RECOVERY', '请输入有效申请编号和原上游邀请码记录 ID');
        }
        $row = $this->execute('SELECT upstream_id,last_error,requested_at FROM member_invitations WHERE request_id=?', [$requestId])->fetch(PDO::FETCH_ASSOC);
        if (!$row) throw new MemberError('INVITE_REQUEST_NOT_FOUND', '邀请码申请不存在', 404);
        if ($row['upstream_id'] !== null) {
            if ((int)$row['upstream_id'] === $upstreamId) return;
            throw new MemberError('INVITE_ALREADY_ASSIGNED', '本设备已有固定邀请码', 409);
        }
        if ($row['last_error'] === 'INVITE_UPSTREAM_DENIED') {
            throw new MemberError('INVITE_RETRY_REQUIRED', '原请求被上游拒绝，请排除原因后从原设备重试', 409);
        }
        // The HTTP request has a 25-second deadline. A crashed worker leaves no
        // last_error; give an active request time to persist its own result first.
        if ($row['last_error'] === null && (int)$row['requested_at'] > time() - 60) {
            throw new MemberError('INVITE_IN_PROGRESS', '邀请码正在获取，请稍后核对', 409);
        }
        $receipt = $this->request('GET', '/admin/redeem-codes/' . $upstreamId, ['x-api-key: ' . $this->config['adminKey']]);
        if (($receipt['id'] ?? null) !== $upstreamId) throw new MemberError('INVITE_RECEIPT_INVALID', '上游记录 ID 不匹配', 409);
        $this->storeInvitation($requestId, $receipt);
    }
}
