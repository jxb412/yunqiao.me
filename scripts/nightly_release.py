"""Prepare a maintenance patch or publish verified desktop build artifacts."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

import deploy_release as mirror
import publish_update as update
from remote_ssh import connect, execute, web_root


REPO = 'jxb412/yunqiao.me'
API = f'repos/{REPO}'
GITHUB = 'https://github.com/' + REPO
WORKFLOW = '.github/workflows/build.yml'
STABLE = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
PLATFORMS = {
    'yunqiao-windows': ('Windows', 'windows-x64', ['win-x64-portable.exe', 'win-x64-setup.exe',
                                                   'win-x64-setup.exe.blockmap', 'win-x64.zip']),
    'yunqiao-macos-arm64': ('macos / macOS arm64', 'macos-arm64', ['mac-arm64.dmg', 'mac-arm64.zip']),
    'yunqiao-macos-x64': ('macos / macOS x64', 'macos-x64', ['mac-x64.dmg', 'mac-x64.zip']),
}
BUILD_SOURCES = {'win-x64': 'GitHub Actions', 'mac-arm64': 'GitHub Actions native macOS arm64',
                 'mac-x64': 'GitHub Actions native macOS x64'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version_tuple(value):
    require(isinstance(value, str) and re.fullmatch(STABLE, value), 'Expected a stable patch version')
    return tuple(map(int, value.split('.')))


def replace_file(path, data):
    temporary = path.with_name(path.name + '.part')
    temporary.write_bytes(data)
    os.replace(temporary, path)


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode('utf-8')


def prepare(worktree, notes_file):
    package_path = worktree / 'package.json'
    package = package_path.read_text(encoding='utf-8')
    old = json.loads(package)['version']
    major, minor, patch = version_tuple(old)
    version = f'{major}.{minor}.{patch + 1}'
    new_doc = worktree / 'docs' / f'RELEASE-{version}.md'
    require(not new_doc.exists(), f'Release note for {version} already exists')
    body = notes_file.read_text(encoding='utf-8-sig').strip() if notes_file else '更新了 Windows 和 macOS 桌面客户端。'
    require(body and len(body) <= 12000, 'Release note must contain 1–12000 characters')
    date = datetime.now(timezone(timedelta(hours=8)))
    stamp = f'{date.year} 年 {date.month} 月 {date.day} 日'
    link = f'[{version}](docs/RELEASE-{version}.md)'
    old_link = f'[{old}](docs/RELEASE-{old}.md)'
    footer = (f'[下载 {version}]({GITHUB}/releases/tag/v{version}) · '
              f'[安装说明]({GITHUB}/blob/v{version}/INSTALLATION.md) · '
              f'[使用指南]({GITHUB}/blob/v{version}/USER-GUIDE.md)')
    changes = {new_doc: f'# 云桥 AI {version}\n\n{body}\n\n{footer}\n'}
    pattern = rf'^(  "version"\s*:\s*"){re.escape(old)}(")'
    changes[package_path], count = re.subn(pattern, rf'\g<1>{version}\2', package, flags=re.M)
    require(count == 1, 'Cannot identify package.json version')
    for name in ['README.md', 'INSTALLATION.md']:
        path = worktree / name
        source = path.read_text(encoding='utf-8')
        require(f'/releases/tag/v{old}' in source, f'Missing current release link in {name}')
        lines = []
        history = 0
        for line in source.splitlines(keepends=True):
            if name == 'README.md' and old_link in line:
                history += 1
                line = line.replace(old_link, link + ' · ' + old_link, 1)
            elif name == 'README.md' and f'[{old} 版本说明](docs/RELEASE-{old}.md)' in line:
                line = f'本版更新内容见 [{version} 版本说明](docs/RELEASE-{version}.md)。\n'
            else:
                line = re.sub(rf'(?<![0-9.]){re.escape(old)}(?![0-9]|\.[0-9])', version, line)
            if '更新于 **' in line:
                line = re.sub(r'更新于 \*\*\d{4} 年 \d+ 月 \d+ 日\*\*', f'更新于 **{stamp}**', line)
            lines.append(line)
        require(name != 'README.md' or history == 1, 'Cannot identify README release history')
        changes[path] = ''.join(lines)
    for path, content in changes.items():
        replace_file(path, content.encode('utf-8'))
    print(version)


def gh(*args, output=None, timeout=60, allow_missing=False):
    # Never include auth headers, environment values or arbitrary API bodies in diagnostics.
    cmd = ['gh', *args]
    env = {**os.environ, 'GH_HOST': 'github.com', 'GH_PROMPT_DISABLED': '1'}
    result = subprocess.run(cmd, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env)
    if result.returncode:
        message = result.stderr.decode('utf-8', 'replace')
        if allow_missing and '(HTTP 404)' in message:
            return None
        code = re.search(r'HTTP (\d{3})', message)
        raise RuntimeError(f'gh {args[0]} failed (exit {result.returncode}' +
                           (f', HTTP {code[1]}' if code else '') + ')')
    return result.stdout


def api(path, *, missing=False):
    for attempt in range(3):
        try:
            raw = gh('api', API + '/' + path, allow_missing=missing)
            return json.loads(raw) if raw is not None else None
        except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
            if attempt == 2 or 'HTTP 4' in str(exc):
                raise
            time.sleep(2 ** attempt)


def remote_text(name, sha):
    data = api(f'contents/{name}?ref={sha}')
    require(data.get('type') == 'file' and data.get('encoding') == 'base64', f'Invalid {name} at commit')
    return base64.b64decode(data['content']).decode('utf-8')


def verify_run(run, sha):
    require(run['head_branch'] == 'main' and run['event'] == 'push' and run['head_sha'] == sha
            and run['path'] == WORKFLOW and run['head_repository']['full_name'] == REPO,
            'Build provenance mismatch')


def wait_build(sha, state, timeout):
    pin = state / 'run.json'
    deadline = time.monotonic() + timeout
    while True:
        if pin.exists():
            selected = json.loads(pin.read_bytes())
            run = api(f"actions/runs/{int(selected['id'])}/attempts/{int(selected['attempt'])}")
        else:
            runs = api('actions/workflows/build.yml/runs?event=push&branch=main&head_sha=' + sha)['workflow_runs']
            run = next((r for r in runs if r['conclusion'] == 'success'), runs[0] if runs else None)
        if run:
            verify_run(run, sha)
            if run['status'] == 'completed':
                require(run['conclusion'] == 'success', f"Build {run['id']} concluded {run['conclusion']}")
                attempt = run['run_attempt']
                jobs = api(f"actions/runs/{run['id']}/jobs?filter=all&per_page=100")['jobs']
                windows = {}
                for artifact, (job, _, _) in PLATFORMS.items():
                    candidates = [j for j in jobs if j['name'] == job and j['run_attempt'] <= attempt]
                    require(candidates, 'Missing desktop job: ' + job)
                    last = max(candidates, key=lambda j: j['run_attempt'])
                    require(last['status'] == 'completed' and last['conclusion'] == 'success', 'Failed job: ' + job)
                    windows[artifact] = (last['started_at'], last['completed_at'])
                replace_file(pin, json_bytes({'id': run['id'], 'attempt': attempt}))
                return run['id'], windows
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f'Waiting for the main push build of {sha}; retry this publication later')
        time.sleep(min(30, remaining))


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked_archive(state, artifact):
    name = artifact['name']
    archive = state / (name + '.zip')
    size = artifact['size_in_bytes']
    digest = artifact.get('digest', '')
    require(type(size) is int and size > 0 and re.fullmatch(r'sha256:[0-9a-f]{64}', digest),
            'Invalid archive digest or size for ' + name)

    def valid(path):
        return path.is_file() and path.stat().st_size == size and sha256(path) == digest[7:]

    if not valid(archive):
        require(not artifact['expired'], 'Artifact has expired: ' + name)
        part = archive.with_suffix('.part')
        for attempt in range(3):
            try:
                with part.open('wb') as target:
                    gh('api', f"{API}/actions/artifacts/{int(artifact['id'])}/zip", output=target, timeout=900)
                require(valid(part), 'Downloaded archive failed verification: ' + name)
                os.replace(part, archive)
                break
            except (RuntimeError, subprocess.TimeoutExpired, OSError, ValueError):
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
    return archive


def unpack(state, payload, artifact, version):
    name = artifact['name']
    _, platform, suffixes = PLATFORMS[name]
    sums = f'SHA256SUMS-{platform}.txt'
    expected = {f'YunQiaoAI-{version}-{suffix}' for suffix in suffixes}
    records = []
    with zipfile.ZipFile(checked_archive(state, artifact)) as archive:
        names = archive.namelist()
        require(len(names) == len(expected) + 1 and set(names) == expected | {sums}, 'Unexpected contents in ' + name)
        require(archive.getinfo(sums).file_size < 65536, 'Oversize checksum file')
        checks = {}
        for line in archive.read(sums).decode('ascii').splitlines():
            match = re.fullmatch(r'([0-9a-fA-F]{64})\s+\*?(?:\./)?([A-Za-z0-9._-]+)', line)
            require(match and match[2] not in checks, 'Invalid platform checksum file')
            checks[match[2]] = match[1].lower()
        require(set(checks) == expected, 'Platform checksums do not cover all files')
        for filename, digest in checks.items():
            size = archive.getinfo(filename).file_size
            require(size > 0, 'Empty package: ' + filename)
            path = payload / filename
            if not path.is_file() or path.stat().st_size != size or sha256(path) != digest:
                temporary = payload / (filename + '.part')
                with archive.open(filename) as source, temporary.open('wb') as dest:
                    shutil.copyfileobj(source, dest, 1024 * 1024)
                require(temporary.stat().st_size == size and sha256(temporary) == digest,
                        'Package checksum mismatch: ' + filename)
                os.replace(temporary, path)
            records.append({'file': filename, 'bytes': size, 'sha256': digest})
    return records


def collect(state, run, windows, sha, version):
    pin = state / 'artifacts.json'
    if pin.exists():
        artifacts = json.loads(pin.read_bytes())
    else:
        artifacts = [a for a in api(f'actions/runs/{run}/artifacts?per_page=100')['artifacts']
                     if a['name'] in PLATFORMS and not a['expired']
                     and windows[a['name']][0] <= a['created_at'] <= windows[a['name']][1]]
    require(len(artifacts) == 3 and {a['name'] for a in artifacts} == PLATFORMS.keys(),
            'Missing or duplicate platform artifacts')
    for a in artifacts:
        provenance = a['workflow_run']
        require(provenance['id'] == run and provenance['head_sha'] == sha and provenance['head_branch'] == 'main'
                and windows[a['name']][0] <= a['created_at'] <= windows[a['name']][1],
                'Artifact provenance mismatch: ' + a['name'])
    replace_file(pin, json_bytes(artifacts))
    payload = state / 'payload'
    payload.mkdir(exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        groups = pool.map(lambda a: unpack(state, payload, a, version), artifacts)
        files = sorted((entry for group in groups for entry in group), key=lambda entry: entry['file'])
    manifest = {'version': version, 'commit': sha, 'githubActionsRun': run, 'buildSources': BUILD_SOURCES, 'files': files}
    replace_file(payload / 'BUILD-MANIFEST.json', json_bytes(manifest))
    sums = ''.join(f"{entry['sha256']}  {entry['file']}\n" for entry in files)
    replace_file(payload / 'SHA256SUMS.txt', sums.encode('ascii'))
    return payload


def tag_commit(tag):
    ref = api(f'git/ref/tags/{tag}', missing=True)
    if ref is None:
        return None
    obj = ref['object']
    while obj['type'] == 'tag':
        obj = api('git/tags/' + obj['sha'])['object']
    require(obj['type'] == 'commit', 'Release tag does not point to a commit')
    return obj['sha']


def public_bytes(url, limit=2_000_000):
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'YunQiao-release'})
    with urllib.request.urlopen(req, timeout=40) as resp:
        require(resp.status == 200 and resp.geturl() == url, 'Unexpected HTTP response for ' + url)
        raw = resp.read(limit + 1)
    require(len(raw) <= limit, 'Oversize public metadata')
    return raw


def public_platform(target):
    platform, arch = target.split('-')
    url = f'https://ai.haowucm.cn/pub.php?action=update&platform={platform}&arch={arch}&current=0.0.0'
    return json.loads(public_bytes(url))


def newer_public_version(version):
    target = version_tuple(version)
    latest = api('releases/latest', missing=True)
    versions = [public_platform('win-x64')['version']]
    if latest:
        require(latest['tag_name'].startswith('v'), 'Unexpected latest GitHub tag')
        versions.append(latest['tag_name'][1:])
    return next((v for v in versions if version_tuple(v) > target), None)


def asset_matches(asset, record):
    return (asset.get('state') == 'uploaded' and asset['size'] == record['bytes']
            and asset.get('digest') == 'sha256:' + record['sha256'])


def check_assets(release, records, allow_missing=False):
    expected = {r['file']: r for r in records}
    seen = set()
    for asset in release['assets']:
        name = asset['name']
        require(name in expected and name not in seen and asset_matches(asset, expected[name]),
                'GitHub release has different or unexpected asset: ' + name)
        seen.add(name)
    missing = sorted(expected.keys() - seen)
    require(allow_missing or not missing, 'GitHub release is missing assets: ' + ', '.join(missing))
    return missing


def stage_github(state, payload, notes, records, sha, version):
    tag = 'v' + version
    marker = f'<!-- yunqiao-nightly-release {sha} -->'
    release = find_release(tag)
    if release and release['draft']:
        require(release['target_commitish'] == sha and marker in (release['body'] or ''),
                'Existing draft does not belong to this publication')
    target = tag_commit(tag)
    require(target is None or target == sha, 'Tag already belongs to a different commit')
    if target is None:
        gh('api', '--method', 'POST', API + '/git/refs', '-f', f'ref=refs/tags/{tag}', '-f', f'sha={sha}')
    require(tag_commit(tag) == sha, 'Tag verification failed')
    if release is None:
        body = state / 'github-notes.md'
        replace_file(body, (notes.rstrip() + '\n\n' + marker + '\n').encode('utf-8'))
        gh('release', 'create', tag, '--repo', REPO, '--verify-tag', '--draft', '--target', sha,
           '--title', f'云桥 AI {version}', '--notes-file', str(body))
        release = find_release(tag)
        require(release, 'New GitHub draft could not be retrieved')
    require(release['tag_name'] == tag and not release['prerelease'], 'Unexpected release type')
    if release['draft']:
        require(release['target_commitish'] == sha and marker in (release['body'] or ''),
                'Existing draft does not belong to this publication')
        names = {r['file'] for r in records}
        starters = [a for a in release['assets'] if a['name'] in names and a.get('state') == 'starter' and a['size'] == 0]
        for asset in starters:
            # GitHub can leave this empty placeholder after a failed asset upload.
            gh('api', '--method', 'DELETE', f"{API}/releases/assets/{int(asset['id'])}")
        if starters:
            release = api(f"releases/{release['id']}")
    missing = check_assets(release, records, allow_missing=release['draft'])
    for name in missing:
        gh('release', 'upload', tag, str(payload / name), '--repo', REPO, timeout=1200)
    release = api(f"releases/{release['id']}")
    check_assets(release, records)
    require(tag_commit(tag) == sha, 'Tag changed during asset upload')
    return release


def find_release(tag):
    release = api('releases/tags/' + tag, missing=True)
    if release is None:
        # Drafts are visible to collaborators in the release list, even before public tag lookup resolves.
        page = 1
        while True:
            releases = api(f'releases?per_page=100&page={page}')
            matches = [r for r in releases if r['tag_name'] == tag]
            require(len(matches) <= 1, 'More than one release for ' + tag)
            if matches:
                return matches[0]
            if len(releases) < 100:
                return None
            page += 1
    return release


@contextmanager
def official_lock(client, root):
    # Keep the remote kernel lock for the SSH connection lifetime, including cross-host publishers.
    lock_path = root + '/releases'
    command = 'flock -xn -- ' + shlex.quote(lock_path) + " sh -c 'echo locked; cat >/dev/null'"
    stdin, stdout, stderr = client.exec_command(command, timeout=30)
    try:
        require(stdout.readline().strip() == 'locked', 'Another official release is publishing')
        yield
    finally:
        stdin.close()
        stdout.channel.close()
        stderr.close()


def existing_manifest(client, directory):
    with client.open_sftp() as sftp:
        try:
            with sftp.open(directory + '/BUILD-MANIFEST.json') as stream:
                raw = stream.read(2_000_001)
        except FileNotFoundError:
            return None
    require(len(raw) <= 2_000_000, 'Oversize official manifest')
    return json.loads(raw)


def mirror_release(client, root, payload, records, sha, version):
    dest = root + '/releases'
    manifest = existing_manifest(client, dest)
    if manifest is not None:
        existing = version_tuple(manifest['version'])
        require(existing <= version_tuple(version), 'Official mirror contains a newer version')
        if manifest['version'] == version:
            require(manifest['commit'] == sha and manifest == json.loads((payload / 'BUILD-MANIFEST.json').read_bytes()),
                    'Official manifest for this version already describes a different build')
    packages = [r for r in records if r['file'].startswith('YunQiaoAI-')]
    shared = [r for r in records if r not in packages]
    # Only the two shared latest-version indexes are replaced; all versioned packages are immutable.
    mirror.upload_files(client, payload, packages, dest)
    mirror.upload_files(client, payload, shared, dest, replace_existing=True)
    for record in records:
        name = record['file']
        url = update.RELEASE_URL + name
        if record in shared:
            require(hashlib.sha256(public_bytes(url)).hexdigest() == record['sha256'],
                    'Public mirror index mismatch: ' + name)
        else:
            request = urllib.request.Request(url, method='HEAD', headers={'Cache-Control': 'no-cache'})
            with urllib.request.urlopen(request, timeout=45) as response:
                require(response.status == 200 and response.geturl() == url
                        and int(response.headers['Content-Length']) == record['bytes'], 'Public package mismatch: ' + name)


def published_targets(payload):
    matches = []
    for target, url in payload['files'].items():
        actual = public_platform(target)
        require(version_tuple(actual['version']) <= version_tuple(payload['version']), 'Newer public update exists')
        same = actual['version'] == payload['version']
        if same:
            require(actual['url'] == url and actual['sha256'] == payload['sha256'][target] and actual['hasUpdate'],
                    'Published same-version update has different files for ' + target)
        matches.append(same)
    return all(matches)


def public_github(sha, version, records):
    release = json.loads(public_bytes(f'https://api.github.com/{API}/releases/tags/v{version}'))
    require(not release['draft'] and not release['prerelease'] and release['tag_name'] == 'v' + version,
            'Public GitHub release is unavailable')
    require(tag_commit('v' + version) == sha, 'Public release tag changed')
    check_assets(release, records)


@contextmanager
def local_lock(state):
    with (state / 'publication.lock').open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            if lock.tell() == 0:
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def publish(sha, version, state_dir, timeout):
    version_tuple(version)
    require(re.fullmatch(r'[0-9a-f]{40}', sha) and timeout >= 0, 'Invalid commit or timeout')
    newer = newer_public_version(version)
    if newer:
        return {'status': 'superseded', 'version': version, 'newer': newer}
    state = state_dir.resolve() / 'releases' / (version + '-' + sha)
    state.mkdir(parents=True, exist_ok=True)
    with local_lock(state):
        return publish_locked(sha, version, state, timeout)


def publish_locked(sha, version, state, timeout):
    pkg = remote_text('package.json', sha)
    require(json.loads(pkg)['version'] == version, 'Version does not match package.json at the requested commit')
    package = state / 'package.json'
    replace_file(package, pkg.encode('utf-8'))
    notes = remote_text(f'docs/RELEASE-{version}.md', sha)
    require(notes.strip(), 'Empty release notes at commit')
    run, windows = wait_build(sha, state, timeout)
    payload = collect(state, run, windows, sha, version)
    _, records = mirror.prepare_files(payload, package)
    summary = re.sub(r'^# [^\n]+\n+', '', notes).split('\n[下载 ', 1)[0].strip()
    update_payload, sizes = update.prepare_release(payload, summary, package)
    root = web_root()
    with connect() as client, official_lock(client, root):
        newer = newer_public_version(version)
        if newer:
            return {'status': 'superseded', 'version': version, 'newer': newer}
        published_targets(update_payload)
        release = stage_github(state, payload, notes, records, sha, version)
        mirror_release(client, root, payload, records, sha, version)
        update.verify_public_files(update_payload, sizes)
        if release['draft']:
            require(not newer_public_version(version), 'Another publisher has published a newer release')
            require(tag_commit('v' + version) == sha, 'Tag changed before publication')
            gh('api', '--method', 'PATCH', f"{API}/releases/{release['id']}", '-F', 'draft=false',
               '-f', 'make_latest=true')
        public_github(sha, version, records)
        if not published_targets(update_payload):
            program = update.publication_program(update_payload, sizes, root)
            result = json.loads(execute(client, 'runuser -u www -- /www/server/php/82/bin/php -r ' + shlex.quote(program)))
            require(result.get('ok') and result['version'] == version, 'Official metadata publication failed')
        require(published_targets(update_payload), 'Official update APIs have not published the verified release')
    return {'status': 'published', 'version': version, 'sha': sha, 'build': run,
            'url': f'{GITHUB}/releases/tag/v{version}'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('--worktree', type=Path, required=True)
    prep.add_argument('--notes-file', type=Path)
    pub = sub.add_parser('publish')
    pub.add_argument('--sha', required=True)
    pub.add_argument('--version', required=True)
    pub.add_argument('--state-dir', type=Path, required=True)
    pub.add_argument('--timeout', type=int, default=5400, help='Maximum seconds to wait for the exact main build')
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.worktree, args.notes_file)
    else:
        with redirect_stdout(sys.stderr):
            result = publish(args.sha, args.version, args.state_dir, args.timeout)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
