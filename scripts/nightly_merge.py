"""Publish or resume CI-verified nightly PRs for jxb412/yunqiao.me.

Run the trusted controller from a checkout with the project's Git origin. Only
publish requires the named local branch to be checked out. All writes are
ordinary fast-forwards. Output is JSON; exits 0 done, 2 pending, 1 error.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlencode


REPO = "jxb412/yunqiao.me"
BASE = "main"
WORKFLOW = ".github/workflows/pull-request.yml"
JOBS = {"Core checks (Windows x64)", "Core checks (macOS arm64)", "Core checks (macOS x64)"}
BRANCH = re.compile(r"nightly/upstream-[0-9]{8}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?")
MARK = re.compile(r"^<!-- yunqiao-nightly-head: ([0-9a-f]{40}) -->$", re.MULTILINE)
ALLOWED_ORIGINS = {url + suffix for url in (
    f"https://github.com/{REPO}", f"git@github.com:{REPO}", f"ssh://git@github.com/{REPO}"
) for suffix in ("", ".git")}


class Pending(RuntimeError):
    """The open PR needs more time or a repaired candidate."""


def run(args, *, data=None, check=True):
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", "GIT_TERMINAL_PROMPT": "0"}
    result = subprocess.run(args, input=data, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=120, env=env)
    if check and result.returncode:
        # Emit only the operation and status; remote messages may contain credentials.
        operation = args[1] if args[0] == "gh" else args[5]
        http = re.search(r"\bHTTP (\d{3})\b", result.stderr)
        detail = f", HTTP {http[1]}" if http else ""
        raise RuntimeError(f"{Path(args[0]).name} {operation} failed (exit {result.returncode}{detail})")
    return result


def git(*args, check=True):
    return run(["git", "-c", f"core.hooksPath={os.devnull}", "-c", "remote.origin.mirror=false",
                *args], check=check)


def api(path, *, payload=None, method=None):
    args = ["gh", "api", "--hostname", "github.com", path]
    if method:
        args += ["--method", method]
    if payload is not None:
        args += ["--input", "-"]
    response = run(args, data=json.dumps(payload) if payload is not None else None)
    return json.loads(response.stdout)


def repo_api(path, **kwargs):
    return api(f"repos/{REPO}/{path}", **kwargs)


def pages(path):
    page = 1
    while True:
        separator = "&" if "?" in path else "?"
        records = repo_api(f"{path}{separator}per_page=100&page={page}")
        yield from records
        if len(records) < 100:
            return
        page += 1


def check_origin():
    for flags in ([], ["--push"]):
        urls = git("remote", "get-url", *flags, "--all", "origin").stdout.splitlines()
        if len(urls) != 1 or urls[0] not in ALLOWED_ORIGINS:
            raise RuntimeError("The checkout needs one origin targeting github.com/" + REPO)


def remote_sha(branch):
    ref = "refs/heads/" + branch
    rows = git("ls-remote", "--refs", "origin", ref).stdout.splitlines()
    if not rows:
        return None
    sha, actual_ref = rows[0].split()
    if len(rows) != 1 or actual_ref != ref or not re.fullmatch("[0-9a-f]{40}", sha):
        raise RuntimeError("Unexpected remote ref")
    return sha


def pr_identity(pr, branch, login):
    return (bool(BRANCH.fullmatch(branch)) and pr["user"]["login"] == login
            and pr["base"]["repo"]["full_name"] == REPO and pr["base"]["ref"] == BASE
            and (pr["head"].get("repo") or {}).get("full_name") == REPO
            and pr["head"]["ref"] == branch)


def marked_head(pr):
    markers = MARK.findall((pr.get("body") or "").replace("\r\n", "\n"))
    return markers[0] if len(markers) == 1 else None


def inspect_pr(number, branch, login, sha):
    pr = repo_api(f"pulls/{number}")
    if not pr_identity(pr, branch, login) or pr["head"]["sha"] != sha or marked_head(pr) != sha:
        raise Pending("PR identity, branch head or recorded candidate changed")
    if pr["state"] != "open" or pr["draft"]:
        raise Pending("PR was closed or marked draft")
    return pr


def candidate_body(body, sha):
    if "<!-- yunqiao-nightly-head:" in body:
        raise ValueError("The PR description contains a reserved commit marker")
    return body.rstrip() + f"\n\n<!-- yunqiao-nightly-head: {sha} -->\n"


def publish(branch, login, title, body):
    if git("symbolic-ref", "--short", "HEAD").stdout.strip() != branch:
        raise ValueError("Publish from the checked-out nightly branch")
    if git("status", "--porcelain", "--untracked-files=normal").stdout:
        raise ValueError("Commit the worktree changes before publishing")
    if not title.strip():
        raise ValueError("An empty PR title cannot be published")
    sha = git("rev-parse", "--verify", "HEAD^{commit}").stdout.strip()
    description = candidate_body(body, sha)
    query = urlencode({"state": "all", "head": f"{REPO.split('/')[0]}:{branch}", "base": BASE})
    prs = list(pages("pulls?" + query))
    existing = next((p for p in prs if p["state"] == "open"), None)
    if existing:
        if not pr_identity(existing, branch, login) or not marked_head(existing) or existing["draft"]:
            raise Pending(f"Existing PR #{existing['number']} needs its owner's review")
        remote = remote_sha(branch)
        if remote != existing["head"]["sha"] or (remote != marked_head(existing) and remote != sha):
            raise Pending(f"Head of PR #{existing['number']} changed outside this publication")
    elif prs:
        merged = next((p for p in prs if pr_identity(p, branch, login) and p.get("merged_at")
                       and p["head"]["sha"] == sha and marked_head(p) == sha), None)
        if merged:
            return merged, sha
        raise Pending("This branch has a closed PR; use a fresh nightly branch")
    elif remote_sha(branch) not in (None, sha):
        raise Pending("The remote branch already belongs to another candidate")

    if git("push", "--no-follow-tags", "origin", f"{sha}:refs/heads/{branch}", check=False).returncode:
        raise Pending("Feature branch push failed; inspect the remote and retry")
    if existing:
        if description != existing["body"] or title != existing["title"]:
            repo_api(f"pulls/{existing['number']}", method="PATCH",
                     payload={"title": title, "body": description})
        return existing, sha
    return repo_api("pulls", method="POST",
                    payload={"head": branch, "base": BASE, "title": title, "body": description}), sha


def workflow_status(pr, workflow_id):
    sha, branch = pr["head"]["sha"], pr["head"]["ref"]
    query = urlencode({"event": "pull_request", "branch": branch, "head_sha": sha, "per_page": 100})
    runs = repo_api(f"actions/workflows/{workflow_id}/runs?{query}")["workflow_runs"]
    matches = [r for r in runs if r["workflow_id"] == workflow_id and r["path"] == WORKFLOW
               and r["head_sha"] == sha and r["head_branch"] == branch and r["event"] == "pull_request"
               and r["repository"]["full_name"] == REPO and (r.get("head_repository") or {}).get("full_name") == REPO
               and r["created_at"] >= pr["created_at"]
               and (not r["pull_requests"] or any(p["number"] == pr["number"] for p in r["pull_requests"]))]
    if not matches:
        return None
    latest = max(matches, key=lambda r: (r["run_number"], r["run_attempt"]))
    if latest["status"] != "completed":
        return None
    if latest["conclusion"] != "success":
        raise Pending(f"PR checks finished with {latest['conclusion']}; run {latest['id']}")
    path = f"actions/runs/{latest['id']}/attempts/{latest['run_attempt']}/jobs?per_page=100"
    jobs = repo_api(path)
    verified = {j["name"] for j in jobs["jobs"] if j["status"] == "completed"
                and j["conclusion"] == "success" and j["head_sha"] == sha}
    if jobs["total_count"] != len(jobs["jobs"]) or not JOBS.issubset(verified):
        raise Pending("The successful workflow is missing verified native jobs")
    return latest["id"]


def verify_fast_forward(branch, sha):
    git("fetch", "--no-tags", "--no-write-fetch-head", "origin", f"refs/heads/{BASE}", f"refs/heads/{branch}")
    main = repo_api("branches/main")
    base_sha = main["commit"]["sha"]
    if main["protected"] or repo_api("rules/branches/main"):
        raise Pending("Main has branch protections; complete the PR through the repository merge process")
    if git("merge-base", "--is-ancestor", base_sha, sha, check=False).returncode:
        raise Pending("Main advanced; integrate the latest main into the nightly branch and rerun PR checks")
    if git("diff", "--quiet", base_sha, sha, "--", WORKFLOW, check=False).returncode:
        raise Pending("The candidate changes its own required workflow and needs review")


def wait_once(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return False
    time.sleep(min(30, remaining))
    return True


def finish(pr, sha, login, workflow_id, deadline):
    number, branch = pr["number"], pr["head"]["ref"]
    url = f"https://github.com/{REPO}/pull/{number}"
    result = {"pr": number, "url": url, "branch": branch, "sha": sha}
    try:
        if pr.get("merged_at"):
            return dict(result, status="merged")
        while True:
            current = inspect_pr(number, branch, login, sha)
            run_id = workflow_status(current, workflow_id)
            if run_id:
                state = current.get("mergeable_state")
                if state in ("clean", "has_hooks"):
                    break
                if state != "unknown" or not wait_once(deadline):
                    raise Pending("GitHub merge state needs another check: " + str(state))
                continue
            if not wait_once(deadline):
                raise Pending("Waiting for the exact candidate's PR workflow")
        result["run"] = f"https://github.com/{REPO}/actions/runs/{run_id}"
        verify_fast_forward(branch, sha)
        current = inspect_pr(number, branch, login, sha)
        if current.get("mergeable_state") not in ("clean", "has_hooks"):
            raise Pending("GitHub merge state changed during verification")
        if workflow_status(current, workflow_id) != run_id:
            raise Pending("The PR checks changed during final verification")
        # A concurrent divergent update to main rejects this ordinary push.
        if git("push", "--no-follow-tags", "origin", f"{sha}:refs/heads/{BASE}", check=False).returncode:
            raise Pending("Fast-forward push was rejected; recheck main and repository rules")
        while True:
            audit = repo_api(f"pulls/{number}")
            if not pr_identity(audit, branch, login) or audit["head"]["sha"] != sha:
                raise Pending("The verified commit was pushed; the PR head changed during reconciliation")
            if audit.get("merged_at") and audit["state"] == "closed":
                return dict(result, status="merged")
            if not wait_once(deadline):
                raise Pending("Verified commit pushed; GitHub PR merge confirmation is pending")
    except Pending as exc:
        return dict(result, status="pending", detail=str(exc))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="command", required=True)
    for mode in ("publish", "resume"):
        sub = modes.add_parser(mode)
        sub.add_argument("--branch", required=mode == "publish")
        sub.add_argument("--timeout", type=int, default=3600, help="seconds to wait for CI (0 checks once)")
        if mode == "publish":
            sub.add_argument("--title-file", type=Path, required=True)
            sub.add_argument("--body-file", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.branch and not BRANCH.fullmatch(args.branch):
        parser.error("expected nightly/upstream-YYYYMMDD with an optional lowercase suffix")
    if not 0 <= args.timeout <= 10800:
        parser.error("timeout must be between 0 and 10800 seconds")
    try:
        check_origin()
        login = api("user")["login"]
        deadline = time.monotonic() + args.timeout
        if args.command == "publish":
            candidates = [publish(args.branch, login, args.title_file.read_text(encoding="utf-8-sig").strip(),
                                  args.body_file.read_text(encoding="utf-8-sig"))]
        else:
            candidates = []
            for pr in pages("pulls?state=open&base=main"):
                branch = pr["head"]["ref"]
                if ((args.branch is None or branch == args.branch) and pr_identity(pr, branch, login)
                        and marked_head(pr)):
                    candidates.append((pr, marked_head(pr)))
        results = []
        if candidates:
            workflow = repo_api("actions/workflows/pull-request.yml")
            if workflow["path"] != WORKFLOW or workflow["name"] != "Pull request checks":
                raise RuntimeError("Expected pull-request workflow is unavailable")
            results = [finish(pr, sha, login, workflow["id"], deadline) for pr, sha in candidates]
        pending = any(r["status"] == "pending" for r in results)
        print(json.dumps({"status": "pending" if pending else "done", "results": results}, ensure_ascii=False))
        return 2 if pending else 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        pending = isinstance(exc, Pending)
        print(json.dumps({"status": "pending" if pending else "error", "detail": str(exc)}, ensure_ascii=False))
        return 2 if pending else 1


if __name__ == "__main__":
    sys.exit(main())
