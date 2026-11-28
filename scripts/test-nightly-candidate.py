"""Verify structured proposals and transactional application using only local Git and model fixtures."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import nightly_candidate as c


FILE = 'src/core/modelContext.ts'
TEST = 'scripts/test-model-context.mjs'
URL = 'https://github.com/farion1231/cc-switch/issues/42'


def evidence(has_items=True):
    kinds = ('releases', 'commits', 'issues', 'issue_comments', 'discussions', 'discussion_comments')
    data = {repo: {'sources': {kind: {'items': []} for kind in kinds}} for repo in c.REPOSITORIES}
    if has_items:
        data[c.REPOSITORIES[0]]['sources']['issues']['items'].append(dict(title='缺省值', excerpt='兼容问题', url=URL))
    return {'complete': True, 'repositories': data}


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.file = self.root / FILE
        self.test = self.root / TEST
        self.file.parent.mkdir(parents=True)
        self.test.parent.mkdir()
        self.file.write_bytes(b'export const limit = 2;\n')
        self.test.write_bytes(b'assert.equal(limit, 2);\n')
        subprocess.run(['git', 'init', '-q', '-b', 'main', self.root], check=True)
        def git(*args):
            subprocess.run(['git', '-C', self.root, *args], check=True, capture_output=True)
        git('remote', 'add', 'origin', 'https://github.com/jxb412/yunqiao.me.git')
        git('add', '.')
        git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
        git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        self.edits = [{'path': FILE, 'before': 'limit = 2', 'after': 'limit = 3'},
                      {'path': TEST, 'before': 'limit, 2', 'after': 'limit, 3'}]
        self.selection = dict(paths=[FILE, TEST], sources=[URL], reason='可用兼容性证据。')
        self.candidate = dict(title='调整兼容值', notes='更新缺省值和回归用例。', edits=self.edits, sources=[URL])

    def test_grounded_selection_and_preserved_worktree_bytes(self):
        self.file.write_bytes(self.file.read_bytes().replace(b'\n', b'\r\n'))
        with patch.object(c, 'request_model', side_effect=[self.selection, self.candidate]) as model:
            result = c.propose(self.root, evidence())
            self.assertEqual(model.call_count, 2)
            self.assertEqual(set(model.call_args.args[1]['public_files']), {FILE, TEST})
        self.assertEqual(result, self.candidate)
        self.assertEqual(c.apply_edits(self.root, result['edits']), [FILE, TEST])
        self.assertEqual(self.file.read_bytes(), b'export const limit = 3;\r\n')

    def test_no_data_or_partial_collection_never_calls_model(self):
        with patch.object(c, 'request_model') as model:
            self.assertEqual(c.propose(self.root, evidence(False))['edits'], [])
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                c.propose(self.root, {'complete': False})
            model.assert_not_called()

    def test_unrelated_path_and_invented_evidence_rejected(self):
        for field, value in [('paths', ['../../private.txt']), ('sources', ['https://unrelated.invalid/'])]:
            with patch.object(c, 'request_model', return_value={**self.selection, field: value}) as model:
                with self.assertRaisesRegex(ValueError, 'unexpected'):
                    c.propose(self.root, evidence())
                self.assertEqual(model.call_count, 1)

    def test_invalid_second_file_or_overlap_leaves_first_untouched(self):
        original = self.file.read_bytes()
        for bad in (dict(self.edits[1], before='absent'), dict(self.edits[0], before='= 2'),
                    dict(self.edits[0], after='fetch("https://example.invalid/")')):
            with self.assertRaises(ValueError):
                c.apply_edits(self.root, [self.edits[0], bad])
            self.assertEqual(self.file.read_bytes(), original)

    def test_dirty_target_and_private_untracked_file_never_forwarded(self):
        self.file.write_text('private local overlay', encoding='utf8')
        other = self.root / 'src/core/providerCredentials.ts'
        other.write_text('private unrelated fixture', encoding='utf8')
        with patch.object(c, 'request_model', side_effect=[self.selection, self.candidate]) as model:
            c.propose(self.root, evidence())
            self.assertNotIn('private', json.dumps(model.call_args.args[1]))
        with self.assertRaisesRegex(ValueError, 'differs'):
            c.apply_edits(self.root, self.edits)
        self.assertEqual(self.file.read_text(), 'private local overlay')

    def test_invalid_model_patch_has_one_bounded_repair(self):
        invalid = dict(self.candidate, edits=[self.edits[0]])
        with patch.object(c, 'request_model', side_effect=[self.selection, invalid, self.candidate]) as model:
            self.assertEqual(c.propose(self.root, evidence()), self.candidate)
            self.assertEqual(model.call_count, 3)
        with patch.object(c, 'request_model', side_effect=[self.selection, invalid, invalid]):
            with self.assertRaisesRegex(ValueError, 'regression fixture'):
                c.propose(self.root, evidence())


if __name__ == '__main__':
    unittest.main()
