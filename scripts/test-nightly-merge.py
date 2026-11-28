"""Exercise nightly CI selection and fast-forward behavior without network or writes."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import nightly_merge as nightly


SHA = "a" * 40
BRANCH = "nightly/upstream-20261128"
LOGIN = "jxb412"


def sample_pr():
    return {
        "number": 12, "state": "open", "draft": False, "user": {"login": LOGIN},
        "created_at": "2026-11-28T00:00:00Z", "mergeable_state": "clean",
        "body": nightly.candidate_body("Test", SHA),
        "base": {"repo": {"full_name": nightly.REPO}, "ref": "main"},
        "head": {"repo": {"full_name": nightly.REPO}, "ref": BRANCH, "sha": SHA},
    }


def sample_run():
    return {
        "workflow_id": 4, "id": 5, "path": nightly.WORKFLOW, "event": "pull_request",
        "head_branch": BRANCH, "head_sha": SHA, "repository": {"full_name": nightly.REPO},
        "head_repository": {"full_name": nightly.REPO}, "created_at": "2026-11-28T00:01:00Z",
        "pull_requests": [{"number": 12}], "status": "completed", "conclusion": "success",
        "run_number": 1, "run_attempt": 1,
    }


def sample_jobs():
    return [{"name": n, "head_sha": SHA, "status": "completed", "conclusion": "success"} for n in nightly.JOBS]


class NightlyMergeTests(unittest.TestCase):
    def status(self, runs, jobs=None):
        jobs = sample_jobs() if jobs is None else jobs
        with patch.object(nightly, "repo_api", side_effect=[{"workflow_runs": runs},
                                                           {"total_count": len(jobs), "jobs": jobs}]):
            return nightly.workflow_status(sample_pr(), 4)

    def test_different_pr_repo_branch_sha_workflow_or_event_cannot_satisfy(self):
        for change in ({"head_repository": {"full_name": "other/fork"}}, {"pull_requests": [{"number": 99}]},
                       {"head_sha": "b" * 40}, {"event": "push"}, {"head_branch": "main"}, {"workflow_id": 7},
                       {"path": "different.yml"}, {"created_at": "2026-11-25T00:01:00Z"}):
            with self.subTest(change=change):
                self.assertIsNone(self.status([dict(sample_run(), **change)]))

    def test_current_attempt_and_all_three_native_jobs_are_required(self):
        self.assertEqual(self.status([sample_run()]), 5)
        pending = dict(sample_run(), run_attempt=2, status="queued")
        self.assertIsNone(self.status([sample_run(), pending]))
        failed = dict(sample_run(), run_number=2, id=6, conclusion="failure")
        with self.assertRaisesRegex(nightly.Pending, "failure"):
            self.status([failed, sample_run()])
        for jobs in (sample_jobs()[1:], [dict(j, head_sha="b"*40) for j in sample_jobs()]):
            with self.assertRaisesRegex(nightly.Pending, "native jobs"):
                self.status([sample_run()], jobs)

    def test_changed_head_or_marker_cannot_merge(self):
        for pr in (dict(sample_pr(), body="deleted marker"), dict(sample_pr(), draft=True),
                   dict(sample_pr(), head=dict(sample_pr()["head"], sha="b" * 40)),
                   dict(sample_pr(), user={"login": "someone-else"})):
            with patch.object(nightly, "repo_api", return_value=pr), patch.object(nightly, "git") as git:
                result = nightly.finish(sample_pr(), SHA, LOGIN, 4, 0)
                self.assertEqual(result["status"], "pending")
                git.assert_not_called()

    def test_divergent_main_or_changed_workflow_keeps_pr_open(self):
        for ancestor, workflow_diff in ((False, False), (True, True)):
            with (patch.object(nightly, "repo_api", side_effect=[
                    {"protected": False, "commit": {"sha": "b" * 40}}, []]),
                  patch.object(nightly, "git", side_effect=[None, SimpleNamespace(returncode=int(not ancestor)),
                                                            SimpleNamespace(returncode=int(workflow_diff))]) as git):
                with self.assertRaises(nightly.Pending):
                    nightly.verify_fast_forward(BRANCH, SHA)
                self.assertNotIn("push", [c.args[0] for c in git.call_args_list])

    def test_rule_protected_branch_will_not_be_directly_pushed(self):
        with (patch.object(nightly, "repo_api", side_effect=[
                {"protected": False, "commit": {"sha": "b" * 40}}, [{"type": "pull_request"}]]),
              patch.object(nightly, "git") as git):
            with self.assertRaisesRegex(nightly.Pending, "protections"):
                nightly.verify_fast_forward(BRANCH, SHA)
            self.assertEqual([c.args[0] for c in git.call_args_list], ["fetch"])

    def test_normal_exact_commit_push_then_readback(self):
        audit = dict(sample_pr(), state="closed", merged_at="2026-11-28T00:10:00Z")
        with (patch.object(nightly, "inspect_pr", return_value=sample_pr()),
              patch.object(nightly, "workflow_status", return_value=8), patch.object(nightly, "verify_fast_forward"),
              patch.object(nightly, "git", return_value=SimpleNamespace(returncode=0)) as git,
              patch.object(nightly, "repo_api", return_value=audit) as api):
            result = nightly.finish(sample_pr(), SHA, LOGIN, 4, 0)
        self.assertEqual(result["status"], "merged")
        git.assert_called_once_with("push", "--no-follow-tags", "origin", f"{SHA}:refs/heads/main", check=False)
        api.assert_called_once_with("pulls/12")

    def test_base_move_rejection_and_unconfirmed_merge_remain_pending(self):
        for rejected in (True, False):
            with (patch.object(nightly, "inspect_pr", return_value=sample_pr()),
                  patch.object(nightly, "workflow_status", return_value=8), patch.object(nightly, "verify_fast_forward"),
                  patch.object(nightly, "git", return_value=SimpleNamespace(returncode=int(rejected))),
                  patch.object(nightly, "repo_api", return_value=sample_pr())):
                result = nightly.finish(sample_pr(), SHA, LOGIN, 4, 0)
                self.assertEqual(result["status"], "pending")
                self.assertIn("pull/12", result["url"])

    def publish_mocks(self, prs):
        def fake_git(*args, **kwargs):
            output = {"symbolic-ref": BRANCH, "status": "", "rev-parse": SHA, "push": ""}
            return SimpleNamespace(returncode=0, stdout=output[args[0]])
        git = self.enterContext(patch.object(nightly, "git", side_effect=fake_git))
        self.enterContext(patch.object(nightly, "pages", return_value=prs))
        self.enterContext(patch.object(nightly, "remote_sha", return_value=SHA))
        return git, self.enterContext(patch.object(nightly, "repo_api", return_value=sample_pr()))

    def test_publish_creates_marked_pr_after_nonforce_push(self):
        git, api = self.publish_mocks([])
        pr, sha = nightly.publish(BRANCH, LOGIN, "title", "body")
        self.assertEqual((pr["number"], sha), (12, SHA))
        self.assertEqual(git.call_args_list[-1].args, ("push", "--no-follow-tags", "origin", f"{SHA}:refs/heads/{BRANCH}"))
        self.assertEqual(api.call_args.kwargs["method"], "POST")
        self.assertEqual(nightly.marked_head(api.call_args.kwargs["payload"]), SHA)

    def test_publish_resumes_unmarked_patch_after_interrupted_repair(self):
        previous = "d" * 40
        pr = dict(sample_pr(), title="Old", body=nightly.candidate_body("body", previous))
        self.publish_mocks([pr])
        with patch.object(nightly, "repo_api") as api:
            nightly.publish(BRANCH, LOGIN, "repaired", "body")
            self.assertEqual(api.call_args.args, ("pulls/12",))
            self.assertEqual(api.call_args.kwargs["method"], "PATCH")
            self.assertEqual(nightly.marked_head(api.call_args.kwargs["payload"]), SHA)

    def test_unowned_existing_pr_prevents_branch_push(self):
        git, api = self.publish_mocks([dict(sample_pr(), body="ordinary PR")])
        with self.assertRaises(nightly.Pending):
            nightly.publish(BRANCH, LOGIN, "title", "body")
        self.assertNotIn("push", [c.args[0] for c in git.call_args_list])
        api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
