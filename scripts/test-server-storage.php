<?php
declare(strict_types=1);
// Isolate the fixed production data path without touching any real web configuration.
$root = sys_get_temp_dir() . '/aurora-server-storage-' . bin2hex(random_bytes(6));
mkdir($root, 0700, true);
$source = (string)file_get_contents(__DIR__ . '/../server/lib.php');
$source = str_replace("const AURORA_DATA_DIR = '/www/aurora-data';", 'const AURORA_DATA_DIR = ' . var_export($root, true) . ';', $source, $replaced);
if ($replaced !== 1) throw new RuntimeException('Storage test isolation failed');
file_put_contents($root . '/lib.php', $source);
require $root . '/lib.php';
function storage_check(bool $okay, string $message): void { if (!$okay) throw new RuntimeException($message); }
function storage_throws(callable $run): void { try { $run(); } catch (RuntimeException $e) { return; } throw new RuntimeException('Expected failed storage operation'); }

$catalog = ['version' => 3, 'providers' => [['key' => 'original']]];
save_catalog($catalog);
storage_check($catalog['version'] === 4 && catalog() === $catalog, 'Persisted version must match caller response');
echo "PASS catalog save updates caller version and persisted catalog\n";

foreach (['', '{broken', '[]', '{"unexpected":"shape"}'] as $bad) {
    file_put_contents($root . '/catalog.json', $bad);
    storage_throws(fn() => catalog());
    storage_check(file_get_contents($root . '/catalog.json') === $bad, 'Corrupt catalog must be preserved');
}
file_put_contents($root . '/config.json', '{broken');
storage_throws(fn() => config());
storage_check(!is_file($root . '/initial-admin-password.txt'), 'Bad configuration must not initialize new credentials');
echo "PASS corrupt configuration and catalog fail closed without overwriting\n";

foreach ([['siteName' => 'preserve', 'update' => ['version' => '9.0.0']], ['passwordHash' => null], ['passwordHash' => ''], ['passwordHash' => []]] as $badConfig) {
    $original = json_encode($badConfig);
    file_put_contents($root . '/config.json', $original);
    storage_throws(fn() => config());
    storage_check(file_get_contents($root . '/config.json') === $original, 'Incomplete existing settings must not reset credentials or release data');
    storage_check(!is_file($root . '/initial-admin-password.txt'), 'Incomplete settings must not generate replacement credentials');
}
echo "PASS incomplete existing configuration cannot trigger fresh-install initialization\n";

file_put_contents($root . '/catalog.json', json_encode($catalog));
mkdir($root . '/catalog.json.tmp' . getmypid());
$before = (string)file_get_contents($root . '/catalog.json');
$beforeSave = $catalog;
storage_throws(function () use (&$catalog): void { save_catalog($catalog); });
storage_check(file_get_contents($root . '/catalog.json') === $before, 'Failed save must retain original');
storage_check($catalog === $beforeSave, 'Failed save must not advance the caller version');
mkdir($root . '/config.json.tmp' . getmypid());
file_put_contents($root . '/config.json', json_encode(['passwordHash' => 'fixture-hash', 'siteName' => 'original']));
storage_throws(fn() => config_update(static function (array $cfg): array { $cfg['siteName'] = 'test'; return $cfg; }));
echo "PASS failed catalog and settings writes raise errors\n";

$release = ['version' => '0.6.0', 'notes' => 'original', 'mandatory' => true, 'files' => ['win-x64' => 'https://example.test/setup.exe', 'mac-arm64' => 'https://example.test/app.dmg'], 'sha256' => ['win-x64' => str_repeat('a', 64), 'mac-arm64' => str_repeat('b', 64)]];
$edited = normalize_update(['notes' => 'new notes'], $release);
storage_check((array)$edited['sha256'] === $release['sha256'] && (array)$edited['files'] === $release['files'] && $edited['mandatory'], 'Notes edit must retain release hashes');
$newVersion = normalize_update(['version' => '0.7.0'], $release);
storage_check((array)$newVersion['sha256'] === [], 'Old hashes must not transfer to a new version');
$newFile = normalize_update(['files' => ['win-x64' => 'https://example.test/new.exe', 'mac-arm64' => $release['files']['mac-arm64']]], $release);
storage_check((array)$newFile['sha256'] === ['mac-arm64' => str_repeat('b', 64)], 'Changed file hash must be removed');
$withHash = normalize_update(['version' => '0.7.0', 'sha256' => ['win-x64' => str_repeat('C', 64)]], $release);
storage_check(((array)$withHash['sha256'])['win-x64'] === str_repeat('c', 64), 'Explicit replacement hash must be accepted');
$failed = false; try { normalize_update(['sha256' => ['win-x64' => 'bad']], $release); } catch (InvalidArgumentException $e) { $failed = true; }
storage_check($failed, 'Invalid checksum must be rejected');
echo "PASS release editing preserves valid hashes and rejects stale or malformed hashes\n";

$provider = normalize_provider(['baseUrl' => 'https://example.test', 'models' => [['id' => 'only-known-id']]]);
foreach (['contextWindow', 'inputPrice', 'outputPrice'] as $field) storage_check(!array_key_exists($field, $provider['models'][0]), 'Unknown model field must stay unknown');
echo "PASS unknown model metadata stays absent\n";
$display = ['baseUrl' => 'https://example.test', 'key' => 'Research & "QA"', 'icon' => '◆', 'color' => ' #AbCd '];
$normalized = normalize_provider($display);
storage_check($normalized['key'] === $display['key'] && $normalized['icon'] === '◆' && $normalized['color'] === '#AbCd', 'Brand color and display data must round-trip');
$display['color'] = 'not a color';
storage_check(normalize_provider($display)['color'] === '#6d8cff', 'Unsupported colors must use the default');
echo "PASS provider branding accepts hexadecimal colors and retains literal keys and icons\n";
$statistics = ['days' => ['2026-01-01' => ['ping' => 3]], 'clients' => []];
store_write('analytics.json', $statistics);
mkdir($root . '/analytics.json.tmp' . getmypid());
storage_throws(fn() => store_update('analytics.json', static fn(array $previous): array => ['days' => [], 'clients' => []]));
storage_check(store_read('analytics.json') === $statistics, 'Failed analytics reset must retain the last complete file');
rmdir($root . '/analytics.json.tmp' . getmypid());
storage_throws(fn() => store_update('analytics.json', static function (array $previous): array { throw new RuntimeException('Expected failure'); }));
$reset = store_update('analytics.json', static fn(array $previous): array => ['days' => [], 'clients' => []]);
storage_check(store_read('analytics.json') === $reset, 'A failed callback must release the analytics lock');
echo "PASS analytics failures retain complete data and release the shared reset lock\n";
rmdir($root . '/config.json.tmp' . getmypid());
unlink($root . '/config.json');
$fresh = config();
storage_check($fresh['update']['version'] === '' && $fresh['update']['notes'] === '' && (array)$fresh['update']['files'] === [] && !isset($fresh['update']['publishedAt']), 'A fresh site must not invent a published release');
storage_check($fresh['stats']['pings'] === 0 && $fresh['stats']['installs'] === 0, 'Fresh statistics must reflect no recorded activity');
$failed = false; try { normalize_update(['notes' => 'not a release'], $fresh['update']); } catch (InvalidArgumentException $error) { $failed = true; }
storage_check($failed, 'Publishing without an actual version must not create a default release');
echo "PASS new installations remain unpublished until an actual release is configured\nAll 8 server storage checks passed.\n";
