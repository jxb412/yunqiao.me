import { app, safeStorage } from 'electron';
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const guid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const hasProtectedMemberStorage = () => safeStorage.isEncryptionAvailable()
  && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');

const options = { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024, encoding: 'utf8' as const };
const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const placeholderUuids = new Set(['03000200-0400-0500-0006-000700080009', '00020003-0004-0005-0006-000700080009']);
let firmwareUuid: string | null | undefined;
async function windowsFirmwareUuid(): Promise<string | null> {
  if (firmwareUuid !== undefined) return firmwareUuid;
  const shell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await execute(shell, ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance -ClassName Win32_ComputerSystemProduct -Property UUID -ErrorAction Stop).UUID'], options);
    const uuid = stdout.trim().toLowerCase();
    const valid = new RegExp('^' + guid + '$').test(uuid)
      && !/^([0f])\1+$/.test(uuid.replaceAll('-', '')) && !placeholderUuids.has(uuid);
    firmwareUuid = valid ? uuid : null;
    return firmwareUuid;
  } catch { throw new Error('无法读取电脑固件标识，请确认 Windows 管理服务可用后重试。'); }
}

async function systemDeviceId(useFirmware: boolean): Promise<string> {
  let value: string | undefined;
  try {
    if (useFirmware) {
      value = await windowsFirmwareUuid() ?? undefined;
    } else if (process.platform === 'win32') {
      const reg = path.join(system32, 'reg.exe');
      const { stdout } = await execute(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], options);
      value = stdout.match(new RegExp('^\\s*MachineGuid\\s+REG_SZ\\s+(' + guid + ')\\s*$', 'im'))?.[1];
    } else if (process.platform === 'darwin') {
      const { stdout } = await execute('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options);
      value = stdout.match(new RegExp('"IOPlatformUUID"\\s*=\\s*"(' + guid + ')"', 'i'))?.[1];
    } else if (process.platform === 'linux') {
      const raw = (await fs.promises.readFile('/etc/machine-id', 'utf8')).trim();
      if (/^[0-9a-f]{32}$/i.test(raw)) value = raw;
    }
  } catch { /* Do not expose the native command's output or raw system identifier. */ }
  if (!value || /^([0f])\1+$/i.test(value.replaceAll('-', ''))) throw new Error('无法读取本机设备标识，暂时无法申请邀请码或领取额度。');
  const scope = useFirmware ? 'yunqiao-member-smbios-v1' : 'yunqiao-member-machine-v1';
  return createHash('sha256').update([scope, process.platform, value.toLowerCase()].join('\0')).digest('hex');
}

async function loadDeviceKey() {
  if (!hasProtectedMemberStorage()) throw new Error('系统安全存储暂不可用，请解锁系统账户后重试。');
  const file = path.join(app.getPath('userData'), 'member-device-key.enc');
  if (!fs.existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const useFirmware = process.platform === 'win32' && !!await windowsFirmwareUuid();
    // Pin the identifier source to this key. Existing PEM-only identities keep
    // their original ID and a temporarily unavailable reader cannot change it.
    const sealed = safeStorage.encryptString(useFirmware ? JSON.stringify({ version: 2, source: 'smbios', pem }) : pem);
    fs.mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, sealed, { flag: 'wx', mode: 0o600 });
      // Exclusive publication across app instances keeps an already approved key intact.
      try { fs.linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  try {
    const saved = safeStorage.decryptString(fs.readFileSync(file));
    const useFirmware = saved.startsWith('{');
    let pem = saved;
    if (useFirmware) {
      const record = JSON.parse(saved);
      if (process.platform !== 'win32' || record.version !== 2 || record.source !== 'smbios' || typeof record.pem !== 'string') throw new Error();
      pem = record.pem;
    }
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    return { key, useFirmware };
  } catch { throw new Error('无法解密设备签名密钥，请使用原系统账户或恢复本机备份。'); }
}

export async function memberDeviceIdentity() {
  const { key, useFirmware } = await loadDeviceKey();
  const deviceId = await systemDeviceId(useFirmware);
  const der = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { deviceId, publicKey: der.toString('base64'), keyId: createHash('sha256').update(der).digest('hex'),
    signChallenge(purpose: 'invite' | 'claim', installationId: string, token: string, challenge: string) {
      if (!/^[a-f0-9]{64}$/.test(challenge)) throw new Error('会员服务返回的设备验证请求无效。');
      const sessionDigest = createHash('sha256').update(token).digest('hex');
      const text = ['yunqiao-member-device-v1', purpose, deviceId, installationId, sessionDigest, challenge].join('\n');
      return sign('sha256', Buffer.from(text, 'utf8'), key).toString('base64');
    },
  };
}
