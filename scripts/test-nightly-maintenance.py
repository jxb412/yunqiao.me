"""Check nightly state transitions in a temporary directory, without network or deployment."""
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import nightly_maintenance as runner
import nightly_upstreams as upstreams


SHA = 'a' * 40
START = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=4)


def evidence(count=1, complete=True):
    return {'complete': complete, 'repositories': {
        'farion1231/cc-switch': {'sources': {'issues': {
            'status': 'ok' if complete else 'error', 'count': count, 'items': []}}}}}


def proposal(edits=()):
    return dict(title='Upstream compatibility', notes='Review completed.', edits=list(edits),
                sources=['https://github.com/farion1231/cc-switch/issues/1'])


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.checkout_dir = self.root / 'checkouts' / 'fixture'
        self.checkout_dir.mkdir(parents=True)
        self.pending_path = self.root / 'pending.json'
        self.cursor_path = self.root / 'cursor.json'
        self.initial_cursor = {'until': START.isoformat()}
        runner.write_json(self.cursor_path, self.initial_cursor)
        self.collect = self.enterContext(patch.object(runner.nightly_upstreams, 'collect', return_value=evidence()))
        self.checkout = self.enterContext(patch.object(runner, 'checkout', return_value=self.checkout_dir))
        self.propose = self.enterContext(patch.object(runner.nightly_candidate, 'propose', return_value=proposal()))
        self.apply = self.enterContext(patch.object(runner.nightly_candidate, 'apply_edits'))
        self.command = self.enterContext(patch.object(runner, 'command'))
        self.git = self.enterContext(patch.object(runner, 'git', return_value=''))
        self.env = self.enterContext(patch.object(runner, 'release_env', return_value={}))
        self.enterContext(redirect_stdout(io.StringIO()))

    def report(self):
        reports = sorted((self.root / 'reports').glob('*.json'), key=lambda path: path.stat().st_mtime_ns)
        return runner.read_json(reports[-1])

    def pending(self):
        state = dict(checkout=str(self.checkout_dir), bundle=str(self.root / 'proposals' / 'fixture'),
                     sha=SHA, branch='nightly/upstream-fixture', version='0.7.3',
                     until=(START + timedelta(hours=6)).isoformat(), phase='pull_request')
        runner.write_json(self.pending_path, state)
        self.git.return_value = SHA
        return state

    def assert_cursor_advanced_to_reviewed_window(self):
        _, until = self.collect.call_args.args
        self.assertGreater(until, START)
        self.assertEqual(runner.read_json(self.cursor_path), {'until': until.isoformat()})

    def test_preview_finds_edits_without_advancing_cursor_or_touching_pending(self):
        saved_pending = self.pending()
        self.git.return_value = ''
        preview_checkout = self.checkout_dir.with_name('preview')
        preview_checkout.mkdir()
        self.checkout.return_value = preview_checkout
        self.propose.return_value = proposal([{'path': 'src/model.ts'}])
        self.assertEqual(runner.run(self.root, preview=True), 0)
        self.assertEqual(self.report()['status'], 'preview_complete')
        self.assertEqual(runner.read_json(self.cursor_path), self.initial_cursor)
        self.assertEqual(runner.read_json(self.pending_path), saved_pending)
        self.assertTrue(self.checkout_dir.exists())
        self.propose.assert_called_once()
        self.apply.assert_not_called()
        self.command.assert_not_called()

    def test_empty_window_advances_without_checkout_or_publication(self):
        self.collect.return_value = evidence(0)
        self.assertEqual(runner.run(self.root, preview=False), 0)
        self.assertEqual(self.report()['status'], 'no_activity')
        self.assert_cursor_advanced_to_reviewed_window()
        self.checkout.assert_not_called()
        self.propose.assert_not_called()
        self.command.assert_not_called()

    def test_review_with_no_product_change_has_no_release(self):
        self.assertEqual(runner.run(self.root, preview=False), 0)
        self.assertEqual(self.report()['status'], 'no_change')
        self.assert_cursor_advanced_to_reviewed_window()
        self.propose.assert_called_once()
        self.apply.assert_not_called()
        self.command.assert_not_called()
        self.env.assert_not_called()
        self.assertFalse(self.pending_path.exists())

    def test_partial_upstreams_preserve_cursor_and_report_evidence(self):
        partial = evidence(count=3, complete=False)
        self.collect.return_value = partial
        self.assertEqual(runner.run(self.root, preview=False), 1)
        self.assertEqual(self.report()['status'], 'incomplete_sources')
        self.assertEqual(self.report()['evidence'], partial)
        self.assertEqual(runner.read_json(self.cursor_path), self.initial_cursor)
        self.checkout.assert_not_called()
        self.command.assert_not_called()

    def test_merged_change_retries_same_publication_after_failure(self):
        state = self.pending()
        self.command.side_effect = [
            json.dumps({'results': [{'status': 'merged', 'sha': SHA}]}),
            RuntimeError('Temporary release service failure'),
            json.dumps({'status': 'published'}),
        ]
        self.assertEqual(runner.run(self.root, preview=False), 1)
        self.assertEqual(self.report()['status'], 'failed')
        self.assertEqual(runner.read_json(self.pending_path), {**state, 'phase': 'release'})
        self.assertEqual(runner.read_json(self.cursor_path), self.initial_cursor)
        self.assertEqual(runner.run(self.root, preview=False), 0)
        self.assertEqual(self.report()['status'], 'published')
        self.assertEqual(runner.read_json(self.cursor_path), {'until': state['until']})
        self.assertFalse(self.pending_path.exists())
        self.checkout.assert_not_called()
        self.propose.assert_not_called()
        calls = [call.args[0] for call in self.command.call_args_list]
        self.assertEqual([Path(args[1]).name for args in calls],
                         ['nightly_merge.py', 'nightly_release.py', 'nightly_release.py'])
        self.assertEqual(calls[1], calls[2])
        self.assertEqual(calls[2][calls[2].index('--sha') + 1], SHA)
        self.assertEqual(calls[2][calls[2].index('--version') + 1], state['version'])

    def test_failed_ci_records_pull_request_for_review_without_deployment(self):
        self.pending()
        outcome = {'results': [{'status': 'pending', 'sha': SHA,
                                'detail': 'PR checks finished with failure; run 42'}]}
        self.command.return_value = json.dumps(outcome)
        self.assertEqual(runner.run(self.root, preview=False), 2)
        self.assertEqual(self.report()['status'], 'needs_review')
        self.assertEqual(self.report()['pull_request'], outcome)
        self.command.assert_called_once()
        self.assertEqual(Path(self.command.call_args.args[0][1]).name, 'nightly_merge.py')
        self.env.assert_not_called()

    def test_running_ci_keeps_candidate_and_cursor_for_next_poll(self):
        state = self.pending()
        self.command.return_value = json.dumps({'results': [
            {'status': 'pending', 'sha': SHA, 'detail': 'Waiting on native platform CI'}]})
        self.assertEqual(runner.run(self.root, preview=False), 2)
        self.assertEqual(self.report()['status'], 'awaiting_merge')
        self.assertEqual(runner.read_json(self.pending_path), state)
        self.assertEqual(runner.read_json(self.cursor_path), self.initial_cursor)
        self.env.assert_not_called()


class EvidenceTests(unittest.TestCase):
    def test_samples_report_clipping_without_losing_exact_count(self):
        rows = [upstreams.record(i, START + timedelta(minutes=i), 'https://github.com/example',
                                 'title', 'x' * 900) for i in range(19)]
        result = upstreams.sample(rows, 'https://github.com/example')
        self.assertEqual(result['count'], len(rows))
        self.assertTrue(result['count_exact'])
        self.assertTrue(result['truncated'])
        self.assertEqual(result['omitted'], len(rows) - upstreams.SAMPLE_SIZE)
        self.assertEqual(result['items'][0]['id'], '18')
        self.assertEqual(result['items'][-1]['id'], '0')
        self.assertTrue(all(len(x['excerpt']) <= upstreams.EXCERPT_SIZE for x in result['items']))

    def test_nested_discussion_reply_on_later_page_is_retained(self):
        gh = object.__new__(upstreams.GitHub)
        since, until = START, START + timedelta(hours=1)
        past = upstreams.stamp(START - timedelta(days=3))
        now = upstreams.stamp(until)
        def node(identity, date):
            return dict(id=identity, createdAt=date, updatedAt=date, bodyText='Feedback', author=None,
                        url='https://github.com/example/repo/discussions/3#' + identity)
        def connection(nodes, cursor=None):
            return dict(nodes=nodes, pageInfo=dict(endCursor=cursor, hasNextPage=bool(cursor)))
        thread = dict(node('thread', past), updatedAt=now, number=3, title='Discussion')
        old_comment = dict(node('comment', past), replies=connection([node('old-reply', past)], 'next'))
        gh.api = Mock(side_effect=[
            {'data': {'node': {'comments': connection([old_comment])}}},
            {'data': {'node': {'replies': connection([node('new-reply', now)])}}}])
        rows = list(upstreams.discussion_comments(gh, [thread], since, until))
        self.assertEqual([r['id'] for r in rows], ['new-reply'])
        self.assertEqual(gh.api.call_args.args[1]['variables'], {'id': 'comment', 'cursor': 'next'})


if __name__ == '__main__':
    unittest.main()
