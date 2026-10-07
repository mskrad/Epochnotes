import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type Entry,
  renderSite,
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

describe('the project page', () => {
  it('is what npm run site makes of the registry and the last watcher report', () => {
    expect(readFileSync(new URL('index.html', root), 'utf8')).toBe(renderSite(entries, watch));
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
    expect(page).not.toMatch(/<script|<link|<img|<iframe|\ssrc=|@import|url\(/i);
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
    const page = renderSite([hostile]);
    const tags = page.match(/<[^>]*>/g) ?? [];
    expect(tags.filter((tag) => /^<(script|img|b)\b|\son\w+=|javascript:/i.test(tag))).toEqual([]);
    expect(page).toContain(
      '&lt;script&gt;alert(&quot;breaks&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;',
    );
    expect(page).not.toContain('href="javascript:');
    expect(
      page.match(/href="([^"]*)"/g)?.every((href) => /^href="(https:\/\/|#|registry\/)/.test(href)),
    ).toBe(true);
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
    expect(kept.upcoming).toEqual([
      { module: 'x', state: { 'mainnet-beta': 'absent', testnet: 'active', devnet: 'active' } },
    ]);
  });
});
