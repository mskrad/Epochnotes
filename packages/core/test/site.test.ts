import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type Entry,
  renderSite,
  type SiteFindings,
  siteFindingsOf,
  type SiteWatch,
  siteWatchOf,
  validatePath,
  type WatchReport,
} from '../src/index.js';

const root = new URL('../../../', import.meta.url);
const entries = validatePath(new URL('registry/entries', root).pathname).files.flatMap((file) =>
  file.entry === undefined ? [] : [file.entry],
);
const watchFile = new URL('site/watch.json', root);
const watch = existsSync(watchFile) ? (JSON.parse(readFileSync(watchFile, 'utf8')) as SiteWatch) : undefined;
const findingsFile = new URL('site/findings.json', root);
const findings = existsSync(findingsFile)
  ? siteFindingsOf(JSON.parse(readFileSync(findingsFile, 'utf8')))
  : undefined;

const finding = {
  project: 'owner/repo',
  repository: 'https://github.com/owner/repo',
  broke: 'It broke.',
  reported: [{ text: 'issue #1', url: 'https://github.com/owner/repo/issues/1' }],
  outcome: 'open',
  outcomeText: 'PR #2',
  outcomeUrl: 'https://github.com/owner/repo/pull/2',
  date: '2026-10-23',
};

describe('the project page', () => {
  it('is what npm run site makes of the registry and the last watcher report', () => {
    expect(readFileSync(new URL('index.html', root), 'utf8')).toBe(renderSite(entries, watch, findings));
  });

  it('names every entry, its primary sources, and the watcher reading', () => {
    const page = renderSite(entries, watch);
    for (const entry of entries) {
      expect(page).toContain(`id="${entry.id}"`);
      for (const source of entry.sources)
        expect(page).toContain(
          source.ref.startsWith('https://') ? `href="${source.ref}"` : source.ref.replaceAll('"', '&quot;'),
        );
    }
    if (watch !== undefined) {
      expect(page).toContain(watch.agave.commit);
      for (const item of watch.upcoming) expect(page).toContain(item.module);
    }
  });

  it('loads nothing from elsewhere', () => {
    const page = renderSite(entries, watch);
    expect(page).not.toMatch(/<script|<img|<iframe|\ssrc=|@import|url\(/i);
    expect(page.match(/<link\b[^>]*>/g)).toEqual([
      expect.stringMatching(/^<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/),
    ]);
  });

  it('shows the text of an entry as text, and links only to https', () => {
    const [first] = entries as [Entry];
    const hostile = {
      ...first,
      id: 'x"><script>alert(1)</script>',
      breaks: [{ ...first.breaks[0], summary: '<script>alert("breaks")</script> & <b>bold</b>' }],
      fix: [{ summary: '<img src=x onerror=alert(1)>' }],
      sources: [
        { kind: 'simd', ref: 'javascript:alert(1)', retrieved: '2026-10-07' },
        { kind: 'simd', ref: 'https://example.org/"onmouseover="alert(1)', retrieved: '2026-10-07' },
      ],
    } as Entry;
    const markup = '"\'><script>alert(1)</script>';
    const everywhere = {
      ...hostile,
      subject: { standard: 'simd', name: markup, title: markup },
      breaks: [...hostile.breaks, { surface: markup, summary: 'x' }],
      applies: {
        activations: [
          { kind: 'feature-account', chain: 'solana', address: markup, label: markup, effect: markup },
          { kind: 'timestamp', chain: markup, at: 0, label: markup, effect: markup },
        ],
      },
    } as unknown as Entry;
    const hostileWatch = {
      agave: { repository: `https://x.org/${markup}`, commit: markup, retrieved: markup },
      clusters: { 'mainnet-beta': { slot: markup }, testnet: { slot: markup }, devnet: { slot: markup } },
      declared: markup,
      inRegistry: markup,
      upcoming: [
        {
          module: markup,
          simd: markup,
          description: markup,
          state: { 'mainnet-beta': markup, testnet: markup, devnet: markup },
          entry: markup,
        },
      ],
    } as unknown as SiteWatch;
    const page = renderSite([hostile, everywhere], hostileWatch);
    expect(page).not.toContain('<script>alert(1)');
    const tags = page.match(/<[^>]*>/g) ?? [];
    expect(tags.filter((tag) => /^<(script|img|b)\b|\son\w+=|javascript:/i.test(tag))).toEqual([]);
    expect(page).toContain(
      '&lt;script&gt;alert(&quot;breaks&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;',
    );
    expect(page).not.toContain('href="javascript:');
    expect(
      page
        .match(/href="([^"]*)"/g)
        ?.every((href) => /^href="(https:\/\/|#|registry\/|data:image\/svg\+xml,)/.test(href)),
    ).toBe(true);
  });

  it('shows every finding with its report and outcome, and counts the merged ones', () => {
    const shown = siteFindingsOf({
      checked: '2026-10-23',
      items: [finding, { ...finding, project: 'other/repo', outcome: 'merged' }],
    });
    const page = renderSite(entries, watch, shown);
    expect(page).toContain('<a href="#findings">Found</a>');
    expect(page).toContain('<strong>2</strong> reported, <strong>1</strong> already fixed and merged');
    expect(page).toContain('<a href="https://github.com/owner/repo/issues/1">issue #1</a>');
    expect(page).toContain(
      '<a href="https://github.com/owner/repo">repo</a><br><span class="muted">owner</span>',
    );
    expect(page).toContain('<span class="state active">merged</span>');
    expect(page).toContain('<span class="state scheduled">open</span>');
    expect(page).toContain('Outcomes as of 2026-10-23');
    expect(page).toContain('04 / The latest field reading');
  });

  it('leaves the findings out, and the numbering as it was, when there are none', () => {
    for (const none of [undefined, { checked: '2026-10-23', items: [] }]) {
      const page = renderSite(entries, watch, none);
      expect(page).not.toContain('id="findings"');
      expect(page).not.toContain('href="#findings"');
      expect(page).toContain('03 / The latest field reading');
      expect(page).toContain('06 / What comes next');
    }
  });

  it('shows the text of a finding as text, and links only to https', () => {
    const markup = '"\'><script>alert(1)</script>';
    const hostile = {
      checked: markup,
      items: [
        {
          project: markup,
          repository: 'javascript:alert(1)',
          broke: markup,
          reported: [{ text: markup, url: 'https://example.org/"onmouseover="alert(1)' }],
          outcome: 'open',
          outcomeText: markup,
          outcomeUrl: 'javascript:alert(1)',
          date: markup,
        },
      ],
    } as SiteFindings;
    const page = renderSite(entries, watch, hostile);
    expect(page).not.toContain('<script>alert(1)');
    expect(page).not.toContain('href="javascript:');
    const tags = page.match(/<[^>]*>/g) ?? [];
    expect(tags.filter((tag) => /^<(script|img)\b|\son\w+=|javascript:/i.test(tag))).toEqual([]);
  });

  it('refuses a findings file it cannot show as written', () => {
    const valid = { checked: '2026-10-23', items: [finding] };
    expect(siteFindingsOf(valid).items).toHaveLength(1);
    const broken: unknown[] = [
      null,
      { items: [finding] },
      { checked: '23.10.2026', items: [finding] },
      { checked: '2026-10-23', items: [{ ...finding, outcome: 'accepted' }] },
      { checked: '2026-10-23', items: [{ ...finding, outcomeUrl: 'http://github.com/owner/repo/pull/2' }] },
      { checked: '2026-10-23', items: [{ ...finding, repository: 'javascript:alert(1)' }] },
      { checked: '2026-10-23', items: [{ ...finding, reported: [] }] },
      { checked: '2026-10-23', items: [{ ...finding, reported: [{ text: 'x', url: 'ftp://x' }] }] },
      { checked: '2026-10-23', items: [{ ...finding, broke: '' }] },
      { checked: '2026-10-23', items: [{ ...finding, date: 'yesterday' }] },
      { checked: '2026-10-23', items: [null] },
    ];
    for (const data of broken) expect(() => siteFindingsOf(data)).toThrow();
  });

  it('says so when there is no watcher report yet', () => {
    expect(renderSite(entries)).toContain('No watcher report yet');
  });

  it('keeps of a watcher report only what the page shows', () => {
    const report = {
      baseline: false,
      agave: {
        repository: 'https://github.com/anza-xyz/agave',
        commit: 'a'.repeat(40),
        retrieved: '2026-10-07',
      },
      clusters: { 'mainnet-beta': { slot: '1' }, testnet: { slot: '2' }, devnet: { slot: '3' } },
      declared: 1,
      inRegistry: 0,
      newlyDeclared: [],
      changes: [],
      drafts: [{ file: 'simd-0001.yaml', yaml: 'secret: draft', features: ['x'] }],
      upcoming: [
        {
          module: 'x',
          address: 'A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS',
          state: { 'mainnet-beta': 'absent', testnet: 'active', devnet: 'active' },
          activatedAt: { testnet: '5', devnet: '6' },
        },
      ],
    } as WatchReport;
    const kept = siteWatchOf(report);
    expect(JSON.stringify(kept)).not.toContain('draft');
    expect(() => siteWatchOf({ ...report, declared: '1' } as unknown as WatchReport)).toThrow('no counts');
    expect(kept.upcoming).toEqual([
      { module: 'x', state: { 'mainnet-beta': 'absent', testnet: 'active', devnet: 'active' } },
    ]);
  });
});
