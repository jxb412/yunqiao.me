"""Run the nightly upstream review, CI-checked update and release from a private state directory."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

import nightly_candidate
import nightly_upstreams


SCRIPTS = Path(__file__).resolve().parent
REPO = 'https://github.com/jxb412/yunqiao.me.git'
CST = timezone(timedelta(hours=8))
DEPLOY_KEYS = {'AURORA_SSH_HOST', 'AURORA_SSH_PORT', 'AURORA_SSH_USER',
               'AURORA_SSH_PASSWORD', 'AURORA_SSH_FINGERPRINT', 'AURORA_WEB_ROOT'}


def read_json(path, default=None):
    return json.loads(path.read_bytes()) if path.is_file() else default


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            stream.write((json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode())
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            temp.unlink(missing_ok=True)
            raise
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


@contextmanager
def single_run(root):
    # The OS releases the byte lock on exit, including after a system restart.
    with (root / 'run.lock').open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def command(args, cwd, env=None, timeout=300, allow_pending=False):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, encoding='utf-8',
                            errors='replace', timeout=timeout)
    if result.returncode == 0 or (allow_pending and result.returncode == 2):
        return result.stdout.strip()
    # Git/HTTP diagnostics can carry private local configuration.
    op = args[1:3] if args[0] == sys.executable else args[:2]
    raise RuntimeError(f'{Path(op[0]).name} {op[1]} exited with {result.returncode}')


def git(cwd, *args):
    return command(['git', '-c', 'core.hooksPath=' + os.devnull, *args], cwd)


def checkout(root, stamp):
    path = root / 'checkouts' / (stamp + '-' + uuid.uuid4().hex[:8])
    path.parent.mkdir(parents=True, exist_ok=True)
    git(root, 'clone', '--no-tags', '--single-branch', '--branch', 'main', REPO, str(path))
    return path


def release_env(root):
    if all(os.environ.get(k) for k in DEPLOY_KEYS):
        return os.environ.copy()
    if os.name != 'nt':
        raise RuntimeError('Deployment credentials are unavailable')
    env = dict(os.environ, YUNQIAO_PROTECTED_SETTINGS=str(root / 'publish.dpapi'))
    ps = ("$ErrorActionPreference='Stop';$s=ConvertTo-SecureString "
          "([IO.File]::ReadAllText($env:YUNQIAO_PROTECTED_SETTINGS));"
          "[Console]::Write([System.Net.NetworkCredential]::new('',$s).Password)")
    raw = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps],
                         env=env, capture_output=True, timeout=30)
    if raw.returncode:
        raise RuntimeError('Cannot unlock local deployment settings under this Windows account')
    settings = json.loads(raw.stdout)
    if set(settings) != DEPLOY_KEYS or not all(isinstance(v, str) and v for v in settings.values()):
        raise ValueError('Incomplete local deployment settings')
    return {**os.environ, **settings}


def cursor(root):
    latest = read_json(root / 'cursor.json')
    if latest:
        return datetime.fromisoformat(latest['until'])
    return datetime.now(timezone.utc) - timedelta(days=1)


def clear_finished_files(root, pending):
    checkout_dir = Path(pending['checkout'])
    if (checkout_dir.is_dir() and checkout_dir.resolve().parent == (root / 'checkouts').resolve()
            and not git(checkout_dir, 'status', '--porcelain')):
        shutil.rmtree(checkout_dir, onexc=remove_readonly)
    release_dir = root / 'releases' / (pending['version'] + '-' + pending['sha'])
    if release_dir.resolve().parent == (root / 'releases').resolve() and release_dir.is_dir():
        shutil.rmtree(release_dir, onexc=remove_readonly)


def run(root, preview):
    started = datetime.now(timezone.utc)
    local = started.astimezone(CST)
    stamp = local.strftime('%Y%m%d-%H%M%S')
    report_path = root / 'reports' / (stamp + ('-preview' if preview else '') + '.json')
    pending_path = root / 'pending.json'
    report = {'started': started.isoformat(), 'mode': 'preview' if preview else 'scheduled'}

    def record(status, **details):
        report.update(status=status, **details)
        write_json(report_path, report)
        print(f'{status} | {report_path}', flush=True)

    try:
        pending = None if preview else read_json(pending_path)
        if pending and pending['phase'] == 'release':
            # A failed deployment may need retrying on another evening. Still
            # collect that night's feedback without marking it processed.
            recent = nightly_upstreams.collect(max(started - timedelta(days=1), cursor(root)), started)
            record('resuming_release', evidence=recent)
        if pending is None:
            since = cursor(root)
            # Long offline periods are consumed in daily slices without jumping past unseen days.
            until = min(started, since + timedelta(hours=25))
            evidence = nightly_upstreams.collect(since, until)
            report.update(window=[since.isoformat(), until.isoformat()], evidence=evidence)
            if not evidence['complete']:
                record('incomplete_sources')
                return 1
            has_news = any(source['count'] for repo in evidence['repositories'].values()
                           for source in repo['sources'].values())
            if not has_news:
                record('no_activity')
                if not preview:
                    write_json(root / 'cursor.json', {'until': until.isoformat()})
                return 0
            path = checkout(root, stamp)
            proposal = nightly_candidate.propose(path, evidence)
            record('reviewed', title=proposal['title'], notes=proposal['notes'],
                   sources=proposal['sources'], files=sorted({e['path'] for e in proposal['edits']}))
            if preview or not proposal['edits']:
                record('preview_complete' if preview else 'no_change')
                if not preview:
                    write_json(root / 'cursor.json', {'until': until.isoformat()})
                # Only this run's generated, disposable, unmodified clone is removed.
                if path.parent.resolve() == (root / 'checkouts').resolve() and not git(path, 'status', '--porcelain'):
                    shutil.rmtree(path, onexc=remove_readonly)
                return 0
            branch = 'nightly/upstream-' + local.strftime('%Y%m%d') + '-' + path.name.split('-')[-1]
            git(path, 'switch', '-c', branch)
            nightly_candidate.apply_edits(path, proposal['edits'])
            bundle = root / 'proposals' / path.name
            bundle.mkdir(parents=True, exist_ok=True)
            (bundle / 'title.txt').write_text(proposal['title'], encoding='utf-8')
            notes = proposal['notes'] + '\n\n' + '\n'.join(proposal['sources']) + '\n'
            (bundle / 'notes.md').write_text(notes, encoding='utf-8')
            package = command([sys.executable, str(SCRIPTS / 'nightly_release.py'), 'prepare',
                               '--worktree', str(path), '--notes-file', str(bundle / 'notes.md')], path)
            git(path, 'add', '-A')
            git(path, 'diff', '--cached', '--check')
            git(path, '-c', 'user.name=YunQiao Nightly', '-c', 'user.email=nightly@users.noreply.github.com',
                'commit', '-m', proposal['title'])
            pending = dict(checkout=str(path), bundle=str(bundle), branch=branch, version=package,
                           sha=git(path, 'rev-parse', 'HEAD'), until=until.isoformat(), phase='pull_request')
            write_json(pending_path, pending)
        path = Path(pending['checkout'])
        if path.resolve().parent != (root / 'checkouts').resolve() or git(path, 'rev-parse', 'HEAD') != pending['sha']:
            raise ValueError('Pending checkout is unavailable or changed')
        report.update(version=pending['version'], sha=pending['sha'], branch=pending['branch'])
        if pending['phase'] == 'pull_request':
            bundle = Path(pending['bundle'])
            result = json.loads(command([sys.executable, str(SCRIPTS / 'nightly_merge.py'), 'publish',
                                         '--branch', pending['branch'], '--title-file', str(bundle / 'title.txt'),
                                         '--body-file', str(bundle / 'notes.md')], path, timeout=4200, allow_pending=True))
            report['pull_request'] = result
            outcomes = result.get('results', [])
            if not any(r.get('sha') == pending['sha'] and r['status'] == 'merged' for r in outcomes):
                # A fixed candidate cannot turn a red check or a divergent base
                # green by waiting forever. Leave its PR and report for review.
                if any(any(term in r.get('detail', '') for term in
                           ('checks finished with', 'Main advanced', 'was closed', 'needs another check',
                            'needs its owner', 'protections', 'changed outside', 'closed PR'))
                       for r in [result, *outcomes]):
                    record('needs_review')
                    write_json(root / 'cursor.json', {'until': pending['until']})
                    pending_path.unlink()
                    return 2
                record('awaiting_merge')
                return 2
            pending['phase'] = 'release'
            write_json(pending_path, pending)
        result = command([sys.executable, str(SCRIPTS / 'nightly_release.py'), 'publish', '--sha',
                          pending['sha'], '--version', pending['version'], '--state-dir', str(root)],
                         path, env=release_env(root), timeout=4 * 3600)
        outcome = json.loads(result.splitlines()[-1])
        if outcome.get('status') not in ('published', 'superseded'):
            raise ValueError('Unrecognized publication result')
        record(outcome['status'], release=outcome)
        write_json(root / 'cursor.json', {'until': pending['until']})
        pending_path.unlink()
        clear_finished_files(root, pending)
        return 0
    except Exception as exc:
        record('failed', error=f'{type(exc).__name__}: {str(exc)[:600]}')
        return 1


def remove_readonly(func, path, error):
    import stat
    if not isinstance(error, PermissionError):
        raise error
    os.chmod(path, stat.S_IWRITE)
    func(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--preview', action='store_true', help='Review live evidence without publishing or advancing the cursor')
    parser.add_argument('--check-runtime', action='store_true', help='Verify the scheduled account and publication dependencies without writing to GitHub or the website')
    args = parser.parse_args()
    root = args.state_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    for key in DEPLOY_KEYS:
        # Deployment inputs are only needed by the release subprocess. Hosted
        # deployments can still provide them through the environment.
        if os.name == 'nt' and (root / 'publish.dpapi').is_file():
            os.environ.pop(key, None)
    with single_run(root):
        if args.check_runtime:
            import paramiko
            from remote_ssh import connect, execute, web_root
            import shlex
            command(['gh', 'api', 'user', '--jq', '.login'], root)
            command(['git', 'ls-remote', '--exit-code', REPO, 'refs/heads/main'], root)
            os.environ.update(release_env(root))
            with connect() as client:
                execute(client, 'test -d ' + shlex.quote(web_root() + '/releases'))
            write_json(root / 'runtime-check.json', {'status': 'ok', 'time': datetime.now(timezone.utc).isoformat(),
                       'git': True, 'github': True, 'official_mirror': True, 'ssh_library': paramiko.__version__})
            return 0
        return run(root, args.preview)


if __name__ == '__main__':
    sys.exit(main())
