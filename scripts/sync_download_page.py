#!/usr/bin/env python3
"""Update the downloads page's local JSON after an official release is published."""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from urllib.request import HTTPRedirectHandler, Request, build_opener


UPDATE_URL = 'https://ai.haowucm.cn/pub.php?action=update&platform=win&arch=x64&current=0.0.0'
RELEASE_BASE = 'https://ai.haowucm.cn/releases/'
MANIFEST_URL = RELEASE_BASE + 'BUILD-MANIFEST.json'
RELEASE_PAGE = 'https://github.com/jxb412/yunqiao.me/releases/tag/v'
MAX_METADATA_BYTES = 1024 * 1024
PAGE_PACKAGES = {
    'windows_portable': 'win-x64-portable.exe',
    'mac_arm64': 'mac-arm64.dmg',
    'mac_x64': 'mac-x64.dmg',
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def public_request(url, method):
    request = Request(url, method=method, headers={'Cache-Control': 'no-cache'})
    response = build_opener(NoRedirect()).open(request, timeout=20)
    if response.status != 200 or response.geturl() != url:
        response.close()
        raise ValueError('Unexpected HTTP response for ' + url)
    return response


def fetch_json(url):
    with public_request(url, 'GET') as response:
        data = response.read(MAX_METADATA_BYTES + 1)
    if len(data) > MAX_METADATA_BYTES:
        raise ValueError('Official release metadata exceeds the size limit')
    return json.loads(data)


def probe_size(url):
    with public_request(url, 'HEAD') as response:
        length = response.headers.get('Content-Length', '')
        if not re.fullmatch(r'[0-9]+', length):
            raise ValueError('Missing or invalid Content-Length for ' + url)
        return int(length)


def version_parts(version):
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('Expected a stable release version')
    return tuple(map(int, version.split('.')))


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', value):
        raise ValueError('Invalid release SHA-256 digest')
    return value.lower()


def publication_date(value):
    if not isinstance(value, str):
        raise ValueError('Missing publishedAt timestamp')
    # Python 3.8 does not accept Z in datetime.fromisoformat.
    timestamp = datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
    if timestamp.tzinfo is None:
        raise ValueError('publishedAt must include a time zone')
    china_time = timezone(timedelta(hours=8))
    return timestamp.astimezone(china_time).date().isoformat()


def make_snapshot(update, manifest):
    if not isinstance(update, dict) or not isinstance(manifest, dict):
        raise ValueError('Expected update metadata and build manifest objects')
    version = update.get('version')
    version_parts(version)
    if manifest.get('version') != version:
        raise ValueError('Published version and mirrored build manifest differ')
    if update.get('platform') != 'win' or update.get('arch') != 'x64':
        raise ValueError('Update metadata does not identify Windows x64')
    if update.get('hasUpdate') is not True:
        raise ValueError('The official update endpoint has not published this release')

    date = publication_date(update.get('publishedAt'))
    prefix = 'YunQiaoAI-' + version + '-'
    setup = prefix + 'win-x64-setup.exe'
    if update.get('url') != RELEASE_BASE + setup:
        raise ValueError('Update URL does not identify the official Windows setup file')
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise ValueError('Build manifest must contain file records')
    files = {}
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('Invalid build manifest record')
        name, size = record.get('file'), record.get('bytes')
        if (not isinstance(name, str) or not name.startswith(prefix)
                or not re.fullmatch(r'[A-Za-z0-9._-]+', name[len(prefix):]) or name in files):
            raise ValueError('Invalid, duplicate, or wrong-version filename in build manifest')
        if type(size) is not int or size <= 0:
            raise ValueError('Invalid byte count for ' + name)
        files[name] = (size, digest(record.get('sha256')))

    if setup not in files or files[setup][1] != digest(update.get('sha256')):
        raise ValueError('Windows setup file or SHA-256 disagrees with the published update')
    assets = {}
    for key, suffix in PAGE_PACKAGES.items():
        name = prefix + suffix
        if name not in files:
            raise ValueError('Missing download package ' + name)
        assets[key] = {'name': name, 'url': RELEASE_BASE + name, 'size': files[name][0]}
    return {'tag': 'v' + version, 'version': version, 'date': date,
            'url': RELEASE_PAGE + version, 'assets': assets}


def write_snapshot(path, candidate, previous_stat):
    descriptor, name = tempfile.mkstemp(dir=str(path.parent), prefix='.' + path.name + '.')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(candidate, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            if previous_stat and hasattr(os, 'fchown'):
                current = os.fstat(stream.fileno())
                if (current.st_uid, current.st_gid) != (previous_stat.st_uid, previous_stat.st_gid):
                    os.fchown(stream.fileno(), previous_stat.st_uid, previous_stat.st_gid)
            os.chmod(name, stat.S_IMODE(previous_stat.st_mode) if previous_stat else 0o644)
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def sync(output, fetch_json=fetch_json, probe_size=probe_size):
    """Return True on replacement, False on unchanged JSON, or raise on failure."""
    path = Path(output)
    update = fetch_json(UPDATE_URL)
    candidate = make_snapshot(update, fetch_json(MANIFEST_URL))
    for asset in candidate['assets'].values():
        actual = probe_size(asset['url'])
        if type(actual) is not int or actual != asset['size']:
            raise ValueError('Unexpected public file size for ' + asset['name'])

    # Read just before publishing. The scheduler serializes writers.
    try:
        with path.open(encoding='utf-8-sig') as stream:
            previous_stat = os.fstat(stream.fileno())
            previous = json.load(stream)
    except FileNotFoundError:
        previous_stat = previous = None
    if previous_stat is not None:
        if not isinstance(previous, dict):
            raise ValueError('Existing snapshot must be a JSON object')
        if version_parts(previous.get('version')) > version_parts(candidate['version']):
            raise ValueError('Refusing to replace a newer snapshot')
        if previous == candidate:
            return False
    write_snapshot(path, candidate, previous_stat)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='downloads page JSON snapshot path')
    args = parser.parse_args()
    try:
        changed = sync(args.output)
    except (ValueError, OSError) as error:
        print('Download page sync failed: {}'.format(error), file=sys.stderr)
        return 1
    print('Updated' if changed else 'Already current')
    return 0


if __name__ == '__main__':
    sys.exit(main())
