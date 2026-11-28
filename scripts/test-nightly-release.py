"""Offline regression checks for nightly release preparation, verification and recovery."""
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import zipfile

import nightly_release as release


ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40
VERSION = '1.2.3'


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)

    def test_prepare_preserves_release_history_and_utf8(self):
        for name in ['package.json', 'README.md', 'INSTALLATION.md']:
            shutil.copy(ROOT / name, self.path / name)
        current = json.loads((self.path / 'package.json').read_bytes())['version']
        history = (self.path / 'README.md').read_text(encoding='utf-8')
        old_links = set(re.findall(r'\[[\d.]+\]\(docs/RELEASE-[\d.]+\.md\)', history))
        (self.path / 'docs').mkdir()
        notes = self.path / 'notes.txt'
        notes.write_text('修复桌面应用连接。', encoding='utf-8')
        with redirect_stdout(io.StringIO()):
            release.prepare(self.path, notes)
        new = json.loads((self.path / 'package.json').read_bytes())['version']
        self.assertNotEqual(new, current)
        readme = (self.path / 'README.md').read_text(encoding='utf-8')
        self.assertTrue(all(link in readme for link in old_links))
        self.assertIn('/tag/v' + new, readme)
        self.assertIn(f'[下载 {new}]', readme)
        self.assertNotIn('/tag/v' + current, (self.path / 'INSTALLATION.md').read_text(encoding='utf-8'))
        self.assertIn('修复桌面应用连接。', (self.path / 'docs' / f'RELEASE-{new}.md').read_text(encoding='utf-8'))

    def artifacts(self, tamper=False):
        artifacts, windows = [], {}
        for i, (name, (_, plat, suffixes)) in enumerate(release.PLATFORMS.items()):
            files = {f'YunQiaoAI-{VERSION}-{s}': s.encode() for s in suffixes}
            checks = ''.join(f'{hashlib.sha256(b).hexdigest()}  ./{n}\n' for n, b in files.items())
            path = self.path / (name + '.zip')
            with zipfile.ZipFile(path, 'w') as z:
                for n, b in files.items():
                    z.writestr(n, b + b'x' if tamper and i == 0 else b)
                z.writestr('SHA256SUMS-' + plat + '.txt', checks)
            artifacts.append({'id': i, 'name': name, 'expired': False, 'size_in_bytes': path.stat().st_size,
                              'digest': 'sha256:' + release.sha256(path), 'created_at': '02',
                              'workflow_run': {'id': 7, 'head_sha': SHA, 'head_branch': 'main'}})
            windows[name] = ('01', '03')
        return artifacts, windows

    def test_collect_reuse_and_validate_for_existing_publish_helpers(self):
        artifacts, windows = self.artifacts()
        with patch.object(release, 'api', return_value={'artifacts': artifacts}):
            payload = release.collect(self.path, 7, windows, SHA, VERSION)
        with patch.object(release, 'api', side_effect=AssertionError('Unexpected API request')):
            self.assertEqual(payload, release.collect(self.path, 7, windows, SHA, VERSION))
        package = self.path / 'package.json'
        package.write_text(json.dumps({'version': VERSION}))
        version, records = release.mirror.prepare_files(payload, package)
        self.assertEqual(version, VERSION)
        self.assertEqual(len(records), 10)
        update, _ = release.update.prepare_release(payload, 'notes', package)
        self.assertEqual(set(update['files']), set(release.update.TARGETS))

    def test_collect_rejects_mismatched_platform_checksum(self):
        artifacts, windows = self.artifacts(tamper=True)
        with patch.object(release, 'api', return_value={'artifacts': artifacts}):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                release.collect(self.path, 7, windows, SHA, VERSION)

    def test_collect_rejects_unrelated_build(self):
        artifacts, windows = self.artifacts()
        artifacts[0]['workflow_run']['head_sha'] = 'b' * 40
        with patch.object(release, 'api', return_value={'artifacts': artifacts}):
            with self.assertRaisesRegex(ValueError, 'provenance mismatch'):
                release.collect(self.path, 7, windows, SHA, VERSION)

    def test_draft_recovery_only_deletes_empty_starter(self):
        record = {'file': 'package', 'sha256': 'b' * 64, 'bytes': 4}
        asset = {'id': 77, 'name': 'package', 'state': 'starter', 'size': 0}
        draft = {'id': 22, 'tag_name': 'v' + VERSION, 'prerelease': False, 'draft': True, 'assets': [asset],
                 'body': f'<!-- yunqiao-nightly-release {SHA} -->', 'target_commitish': SHA}
        ready = {**asset, 'state': 'uploaded', 'size': 4, 'digest': 'sha256:' + record['sha256']}
        with patch.object(release, 'tag_commit', return_value=SHA), patch.object(release, 'find_release', return_value=draft), \
             patch.object(release, 'api', side_effect=[{**draft, 'assets': []}, {**draft, 'assets': [ready]}]), \
             patch.object(release, 'gh') as gh:
            release.stage_github(self.path, self.path, 'note', [record], SHA, VERSION)
            self.assertEqual(gh.call_args_list[0].args[-1], release.API + '/releases/assets/77')
            self.assertEqual(gh.call_args_list[1].args[:2], ('release', 'upload'))
        for details in [{'draft': False}, {'body': 'unrelated'},
                        {'assets': [{**ready, 'digest': 'sha256:' + 'c' * 64}]}]:
            with self.subTest(details=details), patch.object(release, 'tag_commit', return_value=SHA), \
                 patch.object(release, 'find_release', return_value={**draft, **details}), patch.object(release, 'gh') as gh:
                with self.assertRaises(ValueError):
                    release.stage_github(self.path, self.path, 'note', [record], SHA, VERSION)
                gh.assert_not_called()

    def test_downgrade_skips_mutation(self):
        with patch.object(release, 'newer_public_version', return_value='2.0.0'), patch.object(release, 'gh') as gh:
            result = release.publish(SHA, VERSION, self.path, 0)
            self.assertEqual(result['status'], 'superseded')
            gh.assert_not_called()

    def test_official_version_collision_before_upload(self):
        manifest = {'version': VERSION, 'commit': 'b' * 40}
        with patch.object(release, 'existing_manifest', return_value=manifest), patch.object(release.mirror, 'upload_files') as upload:
            with self.assertRaisesRegex(ValueError, 'different build'):
                release.mirror_release(MagicMock(), '/site', self.path, [], SHA, VERSION)
            upload.assert_not_called()

    def test_new_mirror_package_never_replaces_concurrent_upload(self):
        client = MagicMock()
        sftp = client.open_sftp.return_value.__enter__.return_value
        sftp.rename.side_effect = FileExistsError('Concurrent publisher created package')
        record = {'file': 'package', 'bytes': 2, 'sha256': 'a' * 64}
        with patch.object(release.mirror, 'remote_record', side_effect=[None, record, None]), \
             patch.object(release.mirror, 'execute'), redirect_stdout(io.StringIO()):
            with self.assertRaises(FileExistsError):
                release.mirror.upload_files(client, self.path, [record], '/site')
        sftp.posix_rename.assert_not_called()


if __name__ == '__main__':
    unittest.main()
