<?php
declare(strict_types=1);

/** Private methods run inside MemberService; only the authenticated admin page exposes approval. */
trait MemberDeviceProof
{
    private function initializeDeviceProof(PDO $db): void
    {
        $schema = [
            'member_devices' => 'CREATE TABLE member_devices (
                device_hash TEXT PRIMARY KEY, key_id TEXT NOT NULL UNIQUE, active INTEGER NOT NULL CHECK(active IN (0,1)),
                updated_at INTEGER NOT NULL, gift_user_id INTEGER UNIQUE)',
            'member_device_challenges' => 'CREATE TABLE member_device_challenges (
                nonce_hash TEXT PRIMARY KEY, device_hash TEXT NOT NULL REFERENCES member_devices(device_hash),
                context_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)',
        ];
        $actual = $db->query("SELECT name, sql FROM sqlite_master WHERE type='table'
            AND name IN ('member_devices','member_device_challenges')")->fetchAll(PDO::FETCH_KEY_PAIR);
        $version = $db->query("SELECT value FROM member_meta WHERE key='device_proof_version'")->fetchColumn();
        if ($version === '1' && $actual == $schema) return;
        if ($actual || $version !== false) {
            throw new MemberError('STORAGE_UNAVAILABLE', '设备授权账本不完整，请联系管理员恢复备份', 503);
        }
        $db->exec('BEGIN IMMEDIATE');
        try {
            foreach ($schema as $sql) $db->exec($sql);
            $db->exec('CREATE INDEX member_device_challenges_expiry ON member_device_challenges(expires_at);
                CREATE INDEX member_device_challenges_device ON member_device_challenges(device_hash)');
            $db->exec("INSERT INTO member_meta(key,value) VALUES('device_proof_version','1')");
            $db->exec('COMMIT');
        } catch (Throwable $error) {
            $db->exec('ROLLBACK');
            throw $error;
        }
    }

    private function deviceDigest(string $deviceId): string
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $deviceId)) throw new MemberError('DEVICE_ID_INVALID', '设备标识无效');
        return hash_hmac('sha256', 'yunqiao-member-device-id-v1:' . $deviceId, $this->config['secret']);
    }

    private function requireDeviceAdministration(): void
    {
        if (!$this->configured()) throw new MemberError('MEMBERS_DISABLED', '会员服务尚未启用', 503);
    }

    public function adminAuthorizeDevice(string $deviceId, string $keyId): void
    {
        $this->requireDeviceAdministration();
        $hash = $this->deviceDigest($deviceId);
        if (!preg_match('/^[a-f0-9]{64}$/D', $keyId)) throw new MemberError('DEVICE_KEY_INVALID', '设备公钥指纹无效');
        $this->transaction(function () use ($hash, $keyId): void {
            $device = $this->execute('SELECT key_id,active FROM member_devices WHERE device_hash=?', [$hash])->fetch(PDO::FETCH_ASSOC);
            if ($device && $device['active']) {
                if (hash_equals($device['key_id'], $keyId)) return;
                throw new MemberError('DEVICE_KEY_CONFLICT', '该设备已有其他有效公钥，请先核实设备并撤销旧授权', 409);
            }
            if ($this->execute('SELECT 1 FROM member_devices WHERE key_id=? AND device_hash<>?', [$keyId,$hash])->fetchColumn()) {
                throw new MemberError('DEVICE_KEY_CONFLICT', '该公钥已和其他设备绑定', 409);
            }
            $this->execute('INSERT INTO member_devices(device_hash,key_id,active,updated_at) VALUES(?,?,1,?)
                ON CONFLICT(device_hash) DO UPDATE SET key_id=excluded.key_id,active=1,updated_at=excluded.updated_at', [$hash,$keyId,time()]);
        });
    }

    public function adminRevokeDevice(string $deviceHash): void
    {
        $this->requireDeviceAdministration();
        if (!preg_match('/^[a-f0-9]{64}$/D', $deviceHash)) throw new MemberError('DEVICE_ID_INVALID', '设备标识无效');
        $this->transaction(function () use ($deviceHash): void {
            if (!$this->execute('SELECT 1 FROM member_devices WHERE device_hash=?', [$deviceHash])->fetchColumn()) {
                throw new MemberError('DEVICE_NOT_FOUND', '没有找到设备', 404);
            }
            $this->execute('UPDATE member_devices SET active=0,updated_at=? WHERE device_hash=? AND active=1', [time(),$deviceHash]);
            $this->execute('DELETE FROM member_device_challenges WHERE device_hash=?', [$deviceHash]);
        });
    }

    public function adminListDevices(): array
    {
        $this->requireDeviceAdministration();
        $rows = $this->execute('SELECT device_hash AS deviceHash,key_id AS keyId,active,updated_at AS updatedAt
            FROM member_devices ORDER BY updated_at DESC,device_hash LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as &$row) {
            $row['active'] = (bool)$row['active'];
            $row['updatedAt'] = (int)$row['updatedAt'];
        }
        return $rows;
    }

    private function deviceKey(array $body): array
    {
        $value = $body['publicKey'] ?? null;
        $der = is_string($value) && strlen($value) === 124 ? base64_decode($value, true) : false;
        // Canonical named-curve P-256 SPKI with an uncompressed point.
        if ($der === false || strlen($der) !== 91 || !hash_equals(base64_encode($der), $value)
            || !str_starts_with($der, hex2bin('3059301306072a8648ce3d020106082a8648ce3d03010703420004'))) {
            throw new MemberError('DEVICE_PROOF_INVALID', '设备公钥无效，请更新客户端', 403);
        }
        $key = openssl_pkey_get_public("-----BEGIN PUBLIC KEY-----\n" . chunk_split($value, 64, "\n") . "-----END PUBLIC KEY-----\n");
        if ($key === false) throw new MemberError('DEVICE_PROOF_INVALID', '设备公钥无效，请更新客户端', 403);
        return [hash('sha256', $der), $key];
    }

    private function approvedDevice(string $hash, string $keyId): void
    {
        if (!$this->execute('SELECT 1 FROM member_devices WHERE device_hash=? AND key_id=? AND active=1', [$hash,$keyId])->fetchColumn()) {
            throw new MemberError('DEVICE_APPROVAL_REQUIRED', '请将本机设备凭据交给平台管理员核准后重试', 403);
        }
    }

    private function deviceMessage(string $purpose, string $deviceId, array $credentials, string $challenge): string
    {
        $installation = $credentials['installationId'] ?? '';
        $proof = $credentials['installationProof'] ?? '';
        $token = $credentials['sessionToken'] ?? '';
        if (!is_string($installation) || !preg_match('/^[a-zA-Z0-9_-]{16,80}$/D', $installation)
            || !is_string($proof) || !preg_match('/^[a-f0-9]{64}$/D', $proof)) {
            throw new MemberError('INSTALLATION_REQUIRED', '客户端安装凭据无效', 401);
        }
        if (!in_array($purpose, ['invite','claim'], true)
            || ($purpose === 'invite' ? $token !== '' : (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/D', $token)))) {
            throw new MemberError('DEVICE_PROOF_INVALID', '设备请求的用途或登录凭据无效', 403);
        }
        return implode("\n", ['yunqiao-member-device-v1', $purpose, $deviceId, $installation, hash('sha256', $token), $challenge]);
    }

    private function deviceChallenge(array $body, array $credentials, string $remoteAddress): array
    {
        $this->rateLimit('device-challenge-ip', $remoteAddress, 120, 300);
        if (array_diff(array_keys($body), ['deviceId','publicKey','purpose']) || !is_string($body['purpose'] ?? null)) {
            throw new MemberError('DEVICE_PROOF_INVALID', '设备挑战请求无效', 403);
        }
        $deviceId = is_string($body['deviceId'] ?? null) ? $body['deviceId'] : '';
        $hash = $this->deviceDigest($deviceId);
        [$keyId] = $this->deviceKey($body);
        $nonce = bin2hex(random_bytes(32));
        $context = hash('sha256', $this->deviceMessage($body['purpose'], $deviceId, $credentials, $nonce));
        $this->approvedDevice($hash, $keyId);
        // Check approval before recording per-device rate buckets for arbitrary submitted IDs.
        $this->rateLimit('device-challenge-key', $hash, 40, 300);
        $expires = $this->transaction(function () use ($hash, $keyId, $nonce, $context): int {
            $this->approvedDevice($hash, $keyId);
            $now = time();
            $expires = $now + 120;
            $this->execute('DELETE FROM member_device_challenges WHERE expires_at<=?', [$now]);
            $this->execute('INSERT INTO member_device_challenges(nonce_hash,device_hash,context_hash,expires_at) VALUES(?,?,?,?)',
                [hash('sha256',$nonce),$hash,$context,$expires]);
            return $expires;
        });
        return ['ok' => true, 'challenge' => $nonce, 'expiresAt' => $expires];
    }

    private function verifyDeviceProof(string $purpose, array $body, array $credentials): string
    {
        $nonce = $body['challenge'] ?? null;
        $signature = $body['signature'] ?? null;
        if (array_diff(array_keys($body), ['deviceId','publicKey','challenge','signature'])
            || !is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce) || !is_string($signature) || strlen($signature) > 96) {
            throw new MemberError('DEVICE_PROOF_INVALID', '请使用支持设备验证的新版云桥客户端', 403);
        }
        $signatureBytes = base64_decode($signature, true);
        if ($signatureBytes === false || $signatureBytes === '' || !hash_equals(base64_encode($signatureBytes), $signature)) {
            throw new MemberError('DEVICE_PROOF_INVALID', '设备签名格式无效', 403);
        }
        $deviceId = is_string($body['deviceId'] ?? null) ? $body['deviceId'] : '';
        $hash = $this->deviceDigest($deviceId);
        [$keyId, $publicKey] = $this->deviceKey($body);
        $message = $this->deviceMessage($purpose, $deviceId, $credentials, $nonce);
        if (openssl_verify($message, $signatureBytes, $publicKey, OPENSSL_ALGO_SHA256) !== 1) {
            throw new MemberError('DEVICE_PROOF_INVALID', '设备签名验证失败', 403);
        }
        $this->transaction(function () use ($hash, $keyId, $nonce, $message): void {
            $this->approvedDevice($hash, $keyId);
            $used = $this->execute('DELETE FROM member_device_challenges WHERE nonce_hash=? AND device_hash=? AND context_hash=? AND expires_at>?',
                [hash('sha256',$nonce),$hash,hash('sha256',$message),time()]);
            if ($used->rowCount() !== 1) throw new MemberError('DEVICE_PROOF_INVALID', '设备验证已过期或已使用，请重试', 403);
        });
        return $hash;
    }

    /** Called under the SAME BEGIN IMMEDIATE as the welcome grant reservation or legacy backfill. */
    private function reserveDeviceGift(string $deviceHash, int $userId): void
    {
        $device = $this->execute('SELECT active,gift_user_id FROM member_devices WHERE device_hash=?', [$deviceHash])->fetch(PDO::FETCH_ASSOC);
        if (!$device || !$device['active']) throw new MemberError('DEVICE_APPROVAL_REQUIRED', '设备授权已撤销', 403);
        if ($device['gift_user_id'] !== null) {
            if ((int)$device['gift_user_id'] === $userId) return;
            throw new MemberError('DEVICE_ALREADY_CLAIMED', '此设备已为其他会员领取新客额度', 409);
        }
        if (!$this->execute('SELECT 1 FROM member_devices WHERE gift_user_id=?', [$userId])->fetchColumn()) {
            $this->execute('UPDATE member_devices SET gift_user_id=? WHERE device_hash=?', [$userId,$deviceHash]);
        }
    }
}
