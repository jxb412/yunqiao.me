#!/usr/bin/env python3
"""Collect public upstream evidence over an inclusive UTC window. Requires gh for Discussions."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


REPOSITORIES = ('farion1231/cc-switch', 'BigPizzaV3/CodexPlusPlus', 'yetone/magpie')
SAMPLE_SIZE = 5
EXCERPT_SIZE = 420
PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
DISCUSSION_FIELDS = 'id number title url bodyText createdAt updatedAt author { login }'
COMMENT_FIELDS = 'id url bodyText createdAt updatedAt author { login }'


def utc(value):
    if value.utcoffset() is None:
        raise ValueError('Timestamps must include a UTC offset')
    return value.astimezone(timezone.utc)


def parse(value):
    return utc(datetime.fromisoformat(value.replace('Z', '+00:00')))


def stamp(value):
    return utc(value).isoformat().replace('+00:00', 'Z')


def excerpt(value, limit=EXCERPT_SIZE):
    value = ' '.join((value or '').split())
    return value if len(value) <= limit else value[:limit - 1].rstrip() + '…'


def record(identity, date, url, title, body, **extra):
    return dict(id=str(identity), time=stamp(date), url=url, title=excerpt(title, 150),
                excerpt=excerpt(body), **extra)


def event_time(since, until, *dates):
    # A record created in the window may already have been edited after its end.
    eligible = [date for raw in dates if raw and since <= (date := parse(raw)) <= until]
    return max(eligible, default=None)


class GitHub:
    def __init__(self):
        gh = shutil.which('gh')
        if not gh and os.environ.get('LOCALAPPDATA'):
            installed = Path(os.environ['LOCALAPPDATA']) / 'Programs/GitHubCLI/bin/gh.exe'
            gh = str(installed) if installed.is_file() else None
        self.gh = None
        if gh:
            try:
                check = subprocess.run([gh, 'auth', 'status', '--hostname', 'github.com'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
            except (OSError, subprocess.SubprocessError):
                return
            if check.returncode == 0:
                self.gh = gh

    def api(self, path, payload=None):
        if self.gh:
            args = [self.gh, 'api', '--hostname', 'github.com', path]
            data = None
            if payload is not None:
                args.extend(['--input', '-'])
                data = json.dumps(payload).encode('utf-8')
            for attempt in range(2):
                response = subprocess.run(args, input=data, capture_output=True, timeout=70)
                if response.returncode == 0:
                    return json.loads(response.stdout)
                error = response.stderr.decode('utf-8', 'replace')
                if attempt or not any(code in error for code in ('HTTP 502', 'HTTP 503', 'HTTP 504')):
                    raise RuntimeError(excerpt(error or 'GitHub CLI request failed', 260))
                time.sleep(2)
        if payload is not None:
            raise RuntimeError('GitHub GraphQL requires an authenticated gh session on github.com')
        req = Request('https://api.github.com/' + path, headers={
            'User-Agent': 'yunqiao-nightly-upstreams', 'Accept': 'application/vnd.github+json'})
        with urlopen(req, timeout=45) as response:
            return json.load(response)

    def pages(self, repo, path, **params):
        page = 1
        while True:
            query = urlencode(dict(params, per_page=100, page=page))
            rows = self.api(f'repos/{repo}/{path}?{query}')
            if not isinstance(rows, list):
                raise ValueError(f'Expected an array from {path}')
            yield from rows
            if len(rows) < 100:
                return
            page += 1

    def graph_pages(self, query, variables, path, first_page=None):
        connection = first_page
        variables = dict(variables, cursor=None)
        seen = set()
        while True:
            if connection is None:
                result = self.api('graphql', dict(query=query, variables=variables))
                if result.get('errors'):
                    raise RuntimeError(excerpt(str(result['errors'])))
                connection = result['data']
                for part in path:
                    connection = connection[part]
            yield from connection['nodes']
            page_info = connection['pageInfo']
            if not page_info['hasNextPage']:
                return
            cursor = page_info['endCursor']
            if not cursor or cursor in seen:
                raise RuntimeError('Invalid or repeated GraphQL pagination cursor')
            seen.add(cursor)
            variables['cursor'] = cursor
            connection = None


def releases(github, repo, since, until):
    # GitHub sorts release connections by creation, not publication. An old draft
    # can be published today, so stopping at an old creation date loses releases.
    if github.gh:
        owner, name = repo.split('/')
        query = '''query($owner:String!, $name:String!, $cursor:String) {
          repository(owner:$owner, name:$name) {
            releases(first:100, after:$cursor, orderBy:{field:CREATED_AT,direction:DESC}) {
              nodes { id tagName name publishedAt isDraft isPrerelease url description }
              pageInfo { hasNextPage endCursor }
            }
          }
        }'''
        rows = github.graph_pages(query, dict(owner=owner, name=name), ['repository', 'releases'])
        for row in rows:
            date = event_time(since, until, row['publishedAt'])
            if date and not row['isDraft']:
                yield record(row['id'], date, row['url'], row['name'] or row['tagName'],
                             row['description'], tag=row['tagName'], prerelease=row['isPrerelease'])
    else:
        for row in github.pages(repo, 'releases'):
            date = event_time(since, until, row['published_at'])
            if date and not row['draft']:
                yield record(row['node_id'], date, row['html_url'], row['name'] or row['tag_name'],
                             row['body'], tag=row['tag_name'], prerelease=row['prerelease'])


def commits(github, repo, since, until, head_sha):
    rows = github.pages(repo, 'commits', sha=head_sha, since=stamp(since - timedelta(seconds=1)),
                        until=stamp(until + timedelta(seconds=1)))
    for row in rows:
        commit = row['commit']
        date = event_time(since, until, commit['committer']['date'])
        if date:
            title, _, body = commit['message'].partition('\n')
            yield record(row['sha'], date, row['html_url'], title, body, sha=row['sha'])


def issues(github, repo, since, until, *, comments=False):
    path = 'issues/comments' if comments else 'issues'
    # REST's "since" is an exclusive filter with second precision.
    params = dict(since=stamp(since - timedelta(seconds=1)), sort='updated', direction='desc')
    if not comments:
        params['state'] = 'all'
    for row in github.pages(repo, path, **params):
        url = row['html_url']
        if 'pull_request' in row or '/pull/' in url:
            continue
        date = event_time(since, until, row['created_at'], row['updated_at'])
        if date:
            number = row['issue_url'].rsplit('/', 1)[-1] if comments else row['number']
            title = f'Issue #{number}' if comments else row['title']
            extra = dict(number=int(number), author=(row.get('user') or {}).get('login'),
                         created_at=row['created_at'], updated_at=row['updated_at'])
            if not comments:
                extra['state'] = row['state']
            yield record(row['id'], date, url, title, row['body'], **extra)


def discussion_threads(github, repo, since):
    owner, name = repo.split('/')
    query = '''query($owner:String!, $name:String!, $cursor:String) {
      repository(owner:$owner, name:$name) {
        discussions(first:50, after:$cursor, orderBy:{field:UPDATED_AT,direction:DESC}) {
          nodes { %s } %s
        }
      }
    }''' % (DISCUSSION_FIELDS, PAGE_INFO)
    rows = github.graph_pages(query, dict(owner=owner, name=name), ['repository', 'discussions'])
    for thread in rows:
        if parse(thread['updatedAt']) < since:
            return
        yield thread


def discussion_record(node, thread, since, until):
    date = event_time(since, until, node['createdAt'], node['updatedAt'])
    if date:
        return record(node['id'], date, node['url'], thread['title'], node['bodyText'],
                      number=thread['number'], author=(node.get('author') or {}).get('login'),
                      created_at=node['createdAt'], updated_at=node['updatedAt'])
    return None


def discussion_comments(github, threads, since, until):
    query = '''query($id:ID!, $cursor:String) {
      node(id:$id) { ... on Discussion { comments(first:40,after:$cursor) {
        nodes { %s replies(first:10) { nodes { %s } %s } } %s
      } } }
    }''' % (COMMENT_FIELDS, COMMENT_FIELDS, PAGE_INFO, PAGE_INFO)
    reply_query = '''query($id:ID!, $cursor:String) {
      node(id:$id) { ... on DiscussionComment {
        replies(first:100,after:$cursor) { nodes { %s } %s }
      } }
    }''' % (COMMENT_FIELDS, PAGE_INFO)
    for thread in threads:
        if parse(thread['createdAt']) > until:
            continue
        # Old comments can have new replies/edits, so walk every comment of an
        # active discussion, including each nested reply connection's next pages.
        comments = github.graph_pages(query, {'id': thread['id']}, ['node', 'comments'])
        for comment in comments:
            entry = discussion_record(comment, thread, since, until)
            if entry:
                yield entry
            replies = github.graph_pages(reply_query, {'id': comment['id']}, ['node', 'replies'],
                                         first_page=comment['replies'])
            for reply in replies:
                entry = discussion_record(reply, thread, since, until)
                if entry:
                    yield entry


def sample(rows, url):
    records = {}
    result = dict(status='ok', source_url=url)
    try:
        for item in rows:
            if item:
                records[item['id']] = item
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        result.update(status='error', error=excerpt(str(exc), 300))
    ordered = sorted(records.values(), key=lambda item: (parse(item['time']), item['id']), reverse=True)
    count = len(ordered)
    if count > SAMPLE_SIZE:
        # Cover the whole window, retain both boundaries, and keep separate
        # budgets for releases, commits and community sources in every repo.
        ordered = [ordered[i * (count - 1) // (SAMPLE_SIZE - 1)] for i in range(SAMPLE_SIZE)]
    result.update(count=count, count_exact=result['status'] == 'ok', items=ordered,
                  truncated=count > len(ordered), omitted=count - len(ordered))
    return result


def unavailable(url, message, *, disabled=False):
    result = dict(status='disabled' if disabled else 'error', source_url=url, count=0,
                  count_exact=disabled, items=[], truncated=False, omitted=0)
    result['reason' if disabled else 'error'] = excerpt(message, 300)
    return result


def collect_repo(github, repo, since, until):
    base = 'https://github.com/' + repo
    sources = {}
    result = dict(default_branch=None, observed_head_sha=None, has_discussions=None, sources=sources)
    urls = dict(releases=base + '/releases', commits=base + '/commits', issues=base + '/issues',
                issue_comments=base + '/issues', discussions=base + '/discussions',
                discussion_comments=base + '/discussions')
    try:
        metadata = github.api('repos/' + repo)
        result.update(default_branch=metadata['default_branch'], has_discussions=metadata['has_discussions'])
        branch = github.api(f'repos/{repo}/branches/' + quote(result['default_branch'], safe=''))
        result['observed_head_sha'] = branch['commit']['sha']
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        result['metadata_error'] = excerpt(str(exc), 300)
    sources['releases'] = sample(releases(github, repo, since, until), urls['releases'])
    head_sha = result['observed_head_sha']
    sources['commits'] = (sample(commits(github, repo, since, until, head_sha), urls['commits'])
                          if head_sha else unavailable(urls['commits'], result['metadata_error']))
    for key in ('issues', 'issue_comments'):
        sources[key] = sample(issues(github, repo, since, until, comments=key == 'issue_comments'), urls[key])
    disc_url = urls['discussions']
    if result['has_discussions'] is True:
        threads = []

        def read_threads():
            for thread in discussion_threads(github, repo, since):
                threads.append(thread)
                yield discussion_record(thread, thread, since, until)

        sources['discussions'] = sample(read_threads(), disc_url)
        comments = sample(discussion_comments(github, threads, since, until), disc_url)
        if sources['discussions']['status'] == 'error':
            comments.update(status='error', count_exact=False, error=sources['discussions']['error'])
        sources['discussion_comments'] = comments
    else:
        disabled = result['has_discussions'] is False
        reason = 'Repository has disabled GitHub Discussions' if disabled else result['metadata_error']
        for key in ('discussions', 'discussion_comments'):
            sources[key] = unavailable(disc_url, reason, disabled=disabled)
    return result


def collect(since, until):
    """Read all three public repositories. count_exact is false for a failed source."""
    since, until = utc(since), utc(until)
    if since > until:
        raise ValueError('Window start must be at or before its end')
    github = GitHub()
    with ThreadPoolExecutor(max_workers=len(REPOSITORIES)) as pool:
        futures = {repo: pool.submit(collect_repo, github, repo, since, until) for repo in REPOSITORIES}
        repositories = {repo: task.result() for repo, task in futures.items()}
    complete = all(source['status'] != 'error' for repo in repositories.values()
                   for source in repo['sources'].values())
    return dict(since=stamp(since), until=stamp(until), complete=complete, sample_size=SAMPLE_SIZE,
                repositories=repositories)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('window', nargs='*', metavar='TIMESTAMP')
    parser.add_argument('--since', type=parse)
    parser.add_argument('--until', type=parse)
    args = parser.parse_args()
    if args.window:
        if len(args.window) != 2 or args.since or args.until:
            parser.error('Supply two positional timestamps or --since and --until')
        args.since, args.until = map(parse, args.window)
    if args.since is None or args.until is None:
        parser.error('A start and end timestamp with explicit UTC offsets are required')
    output = collect(args.since, args.until)
    sys.stdout.buffer.write((json.dumps(output, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return 0 if output['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
