import { readFileSync } from 'node:fs';

import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';

import {
  fetchPullRequestState,
  type PullRequestState,
  pullRequestRef,
  readmeWithFindings,
  refreshFindings,
  renderSite,
  type SiteFinding,
  type SiteFindings,
  siteFindingsOf,
  watchedPullRequests,
} from '../src/index.js';

const root = new URL('../../../', import.meta.url);

const item = (project: string, outcome: SiteFinding['outcome'], number: number): SiteFinding => ({
  project,
  repository: `https://github.com/${project}`,
  broke: `${project} broke.`,
  reported: [{ text: `PR #${number}`, url: `https://github.com/${project}/pull/${number}` }],
  outcome,
  outcomeText: `PR #${number}`,
  outcomeUrl: `https://github.com/${project}/pull/${number}`,
  date: '2026-10-20',
});

const open: PullRequestState = { state: 'open', mergedAt: null, closedAt: null };
const merged: PullRequestState = {
  state: 'closed',
  mergedAt: '2026-10-25T13:00:00Z',
  closedAt: '2026-10-25T13:00:00Z',
};
const closed: PullRequestState = { state: 'closed', mergedAt: null, closedAt: '2026-10-24T09:00:00Z' };

const findings: SiteFindings = {
  checked: '2026-10-24',
  items: [item('a/merged', 'merged', 1), item('b/open', 'open', 2), item('c/open', 'open', 3)],
};

describe('pull request links', () => {
  it('reads a github.com pull request and nothing else', () => {
    expect(pullRequestRef('https://github.com/OpenZeppelin/openzeppelin-monitor/pull/519')).toEqual({
      owner: 'OpenZeppelin',
      repo: 'openzeppelin-monitor',
      number: 519,
    });
    expect(pullRequestRef('https://github.com/a/b/issues/48')).toBeUndefined();
    expect(pullRequestRef('https://gitlab.com/a/b/pull/1')).toBeUndefined();
  });

  it('watches only pull requests that are not merged yet', () => {
    const issue = { ...item('d/issue', 'open', 4), outcomeUrl: 'https://github.com/d/issue/issues/4' };
    expect(watchedPullRequests({ ...findings, items: [...findings.items, issue] })).toEqual([
      'https://github.com/b/open/pull/2',
      'https://github.com/c/open/pull/3',
    ]);
  });
});

describe('refreshing outcomes', () => {
  it('moves a newly merged finding behind the merged ones, dated by its merge', () => {
    const pulls = new Map([
      ['https://github.com/b/open/pull/2', open],
      ['https://github.com/c/open/pull/3', merged],
    ]);
    const { findings: next, changes } = refreshFindings(findings, pulls, '2026-10-27');
    expect(next.items.map((finding) => [finding.project, finding.outcome, finding.date])).toEqual([
      ['a/merged', 'merged', '2026-10-20'],
      ['c/open', 'merged', '2026-10-25'],
      ['b/open', 'open', '2026-10-20'],
    ]);
    expect(changes).toEqual(['c/open: PR #3 open -> merged']);
    expect(next.checked).toBe('2026-10-27');
  });

  it('marks a pull request closed without merging, and open again when it is reopened', () => {
    const pulls = new Map([['https://github.com/b/open/pull/2', closed]]);
    const { findings: shut } = refreshFindings(findings, pulls, '2026-10-27');
    expect(shut.items.find((finding) => finding.project === 'b/open')).toMatchObject({
      outcome: 'closed',
      date: '2026-10-24',
    });
    const { findings: reopened, changes } = refreshFindings(
      shut,
      new Map([['https://github.com/b/open/pull/2', open]]),
      '2026-10-28',
    );
    expect(reopened.items.find((finding) => finding.project === 'b/open')?.outcome).toBe('open');
    expect(changes).toEqual(['b/open: PR #2 closed -> open']);
  });

  it('keeps the check date when nothing moved, until the last check is a week old', () => {
    const quiet = new Map([['https://github.com/b/open/pull/2', open]]);
    expect(refreshFindings(findings, quiet, '2026-10-30')).toEqual({ findings, changes: [] });
    expect(refreshFindings(findings, quiet, '2026-10-31').findings.checked).toBe('2026-10-31');
  });

  it('never reopens a merged finding', () => {
    const pulls = new Map([['https://github.com/a/merged/pull/1', open]]);
    expect(refreshFindings(findings, pulls, '2026-10-25').findings.items[0]?.outcome).toBe('merged');
  });
});

describe('the README findings table', () => {
  const readme = [
    '## Found in the field',
    '',
    'We checked repositories. Three are reported; one is already fixed and merged. Outcomes as of 2026-10-24; an open pull request is a proposal.',
    '',
    '| Project | What broke | Report | Outcome |',
    '| --- | --- | --- | --- |',
    '| [a/merged](https://github.com/a/merged) | Hand-written `a` | [PR #1](https://github.com/a/merged/pull/1) | merged: [PR #1](https://github.com/a/merged/pull/1), 2026-10-20 |',
    '| [b/open](https://github.com/b/open) | Hand-written `b` | [PR #2](https://github.com/b/open/pull/2) | open |',
    '| [c/open](https://github.com/c/open) | Hand-written `c` | [PR #3](https://github.com/c/open/pull/3) | open |',
    '',
  ].join('\n');

  it('updates the summary and the Outcome column and keeps the hand-written wording', () => {
    const pulls = new Map([['https://github.com/c/open/pull/3', merged]]);
    const next = readmeWithFindings(readme, refreshFindings(findings, pulls, '2026-10-27').findings);
    expect(next).toContain(
      'Three are reported; two are already fixed and merged. Outcomes as of 2026-10-27;',
    );
    const rows = next.split('\n').filter((line) => line.startsWith('| ['));
    expect(rows[1]).toBe(
      '| [c/open](https://github.com/c/open) | Hand-written `c` | [PR #3](https://github.com/c/open/pull/3) | merged: [PR #3](https://github.com/c/open/pull/3), 2026-10-25 |',
    );
    expect(rows[2]).toContain('Hand-written `b`');
  });

  it('refuses a finding the README has no row for', () => {
    const extra = { ...findings, items: [...findings.items, item('d/new', 'open', 4)] };
    expect(() => readmeWithFindings(readme, extra)).toThrow('no row for d/new');
  });

  it('matches the findings file of this repository as prettier writes it', async () => {
    const actual = readFileSync(new URL('README.md', root), 'utf8');
    const shown = siteFindingsOf(JSON.parse(readFileSync(new URL('site/findings.json', root), 'utf8')));
    const options = (await resolveConfig(new URL('README.md', root).pathname)) ?? {};
    expect(await format(readmeWithFindings(actual, shown), { ...options, parser: 'markdown' })).toBe(actual);
  });
});

describe('reading a pull request from GitHub', () => {
  it('reports the merge time and sends the token when there is one', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response(
        JSON.stringify({
          state: 'closed',
          merged_at: '2026-10-26T18:00:00Z',
          closed_at: '2026-10-26T18:00:00Z',
        }),
      );
    }) as unknown as typeof fetch;
    const state = await fetchPullRequestState(
      { owner: 'o', repo: 'r', number: 7 },
      { token: 't', fetch: fake },
    );
    expect(state).toEqual({
      state: 'closed',
      mergedAt: '2026-10-26T18:00:00Z',
      closedAt: '2026-10-26T18:00:00Z',
    });
    expect(seen[0]?.url).toBe('https://api.github.com/repos/o/r/pulls/7');
    expect(seen[0]?.headers.authorization).toBe('Bearer t');
  });

  it('fails instead of guessing when GitHub does not answer with a pull request', async () => {
    const missing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    await expect(
      fetchPullRequestState({ owner: 'o', repo: 'r', number: 7 }, { fetch: missing }),
    ).rejects.toThrow('GitHub answered 404');
  });
});

describe('a closed finding on the page', () => {
  it('says closed instead of open', () => {
    const page = renderSite([], undefined, {
      checked: '2026-10-27',
      items: [{ ...item('b/open', 'closed', 2) }],
    });
    expect(page).toContain('<span class="outcome-icon closed" aria-hidden="true">');
    expect(page).toContain('PR #2 closed');
  });
});
