"""Exercise the download-page publisher against an in-memory upstream and a temporary snapshot."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import sync_download_page as publisher


PACKAGES = {
    'windows_portable': ('win-x64-portable.exe', 1019),
    'mac_arm64': ('mac-arm64.dmg', 1233),
    'mac_x64': ('mac-x64.dmg', 1284),
}
RELEASE_BASE = 'https://ai.haowucm.cn/releases/'


def package_name(version, suffix):
    return f'YunQiaoAI-{version}-{suffix}'


def page_snapshot(version):
    assets = {}
    for key, (suffix, size) in PACKAGES.items():
        name = package_name(version, suffix)
        assets[key] = {'name': name, 'url': RELEASE_BASE + name, 'size': size}
    return {
        'tag': 'v' + version, 'version': version, 'date': '2026-11-28',
        'url': f'https://github.com/jxb412/yunqiao.me/releases/tag/v{version}', 'assets': assets,
    }


class FakeRelease:
    def __init__(self, version):
        records = []
        self.sizes = {}
        for suffix, size in [*PACKAGES.values(), ('win-x64-setup.exe', 1130)]:
            name = package_name(version, suffix)
            digest = hashlib.sha256(name.encode('ascii')).hexdigest()
            records.append({'file': name, 'bytes': size, 'sha256': digest})
            self.sizes[RELEASE_BASE + name] = size
        self.manifest = {'version': version, 'files': records}
        self.update = {
            'platform': 'win', 'arch': 'x64', 'version': version, 'hasUpdate': True,
            'url': RELEASE_BASE + records[-1]['file'], 'sha256': records[-1]['sha256'],
            'publishedAt': '2026-11-27T18:30:00Z',
        }
        self.probed = []

    def fetch_json(self, url):
        return {publisher.UPDATE_URL: self.update, publisher.MANIFEST_URL: self.manifest}[url]

    def probe_size(self, url):
        self.probed.append(url)
        if url not in self.sizes:
            raise FileNotFoundError(url)
        return self.sizes[url]


class DownloadPageSyncTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name) / 'downloads.json'
        self.output.write_text(json.dumps(page_snapshot('0.6.9'), indent=4), encoding='utf-8')
        self.before = self.output.read_bytes()
        self.release = FakeRelease('0.6.10')

    def sync(self):
        return publisher.sync(self.output, fetch_json=self.release.fetch_json, probe_size=self.release.probe_size)

    def assert_rejected(self, errors=(ValueError, RuntimeError, OSError)):
        with self.assertRaises(errors):
            self.sync()
        self.assertEqual(self.output.read_bytes(), self.before)

    def test_publish_updates_all_three_buttons_together(self):
        self.assertIs(self.sync(), True)
        page = json.loads(self.output.read_bytes())
        self.assertEqual(page, page_snapshot('0.6.10'))
        for asset in page['assets'].values():
            self.assertIn(asset['url'], self.release.probed)

    def test_same_release_keeps_existing_file_without_writing(self):
        self.assertIs(self.sync(), True)
        saved = self.output.read_bytes()
        os.utime(self.output, (1_600_000_000, 1_600_000_000))
        stamp = self.output.stat().st_mtime_ns
        self.assertIs(self.sync(), False)
        self.assertEqual(self.output.read_bytes(), saved)
        self.assertEqual(self.output.stat().st_mtime_ns, stamp)

    def test_same_version_repairs_an_incorrect_download_url(self):
        current = page_snapshot('0.6.10')
        current['assets']['windows_portable']['url'] = self.release.update['url']
        self.output.write_text(json.dumps(current), encoding='utf-8')
        self.assertIs(self.sync(), True)
        self.assertEqual(json.loads(self.output.read_bytes()), page_snapshot('0.6.10'))

    def test_manifest_appearing_before_update_api_defers_the_switch(self):
        self.release.manifest = FakeRelease('0.6.11').manifest
        self.assert_rejected()

    def test_api_without_a_published_update_keeps_existing_snapshot(self):
        self.release.update['hasUpdate'] = False
        self.assert_rejected()

    def test_missing_platform_in_manifest_keeps_old_release(self):
        self.release.manifest['files'].pop(2)
        self.assert_rejected()

    def test_download_failure_on_last_platform_keeps_all_old_buttons(self):
        del self.release.sizes[RELEASE_BASE + package_name('0.6.10', 'mac-x64.dmg')]
        self.assert_rejected()

    def test_incomplete_download_on_one_platform_keeps_all_old_buttons(self):
        self.release.sizes[RELEASE_BASE + package_name('0.6.10', 'mac-arm64.dmg')] -= 1
        self.assert_rejected()

    def test_numeric_version_comparison_blocks_a_downgrade(self):
        self.output.write_text(json.dumps(page_snapshot('0.6.11')), encoding='utf-8')
        self.before = self.output.read_bytes()
        self.release = FakeRelease('0.6.9')
        self.assert_rejected()

    def test_update_digest_must_match_manifest(self):
        self.release.update['sha256'] = '0' * 64
        self.assert_rejected()

    def test_invalid_manifest_response_keeps_existing_snapshot(self):
        fetch_json = self.release.fetch_json

        def truncated_manifest(url):
            if url == publisher.MANIFEST_URL:
                return json.loads('{"version":')
            return fetch_json(url)

        self.release.fetch_json = truncated_manifest
        self.assert_rejected()

    def test_failure_to_replace_file_keeps_existing_snapshot(self):
        with patch('os.replace', side_effect=OSError('simulated filesystem failure')):
            self.assert_rejected()

    def test_unreadable_snapshot_is_preserved(self):
        for original in (b'{"version":', b'null'):
            with self.subTest(original=original):
                self.output.write_bytes(original)
                self.before = original
                self.assert_rejected()


if __name__ == '__main__':
    unittest.main()
