import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import semver from 'semver';

import { validatePath } from './load.js';
import type { Entry } from './schema.js';
import type { Issue } from './validate.js';

type DetectRule = Entry['detect'][number];
type Language = Extract<DetectRule, { kind: 'code-pattern' }>['languages'][number];

const EXTENSIONS: Record<Language, string[]> = {
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  rust: ['.rs'],
  python: ['.py'],
  go: ['.go'],
  markdown: ['.md', '.mdx'],
};
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  'coverage',
]);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock']);
const MAX_FILE_BYTES = 1024 * 1024;

export interface Finding {
  entry: string;
  rev: number;
  rule: string;
  kind: DetectRule['kind'];
  confidence: DetectRule['confidence'];
  summary: string;
  /** Path relative to the scanned directory. */
  file: string;
  /** 1-based; 0 for a lockfile finding that has no single line. */
  line: number;
  excerpt: string;
  fix: string[];
}

export type CheckReport =
  | {
      ok: true;
      root: string;
      filesScanned: number;
      findings: Finding[];
      notRun: { entry: string; rule: string; reason: string }[];
    }
  | { ok: false; issues: Issue[] };

function* walk(root: string, directory = root): Generator<string> {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue; // a dangling symlink
    }
    if (stats.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(name)) yield* walk(root, path);
    } else if (stats.isFile() && stats.size <= MAX_FILE_BYTES) yield path;
  }
}

/** Versions of one package as the lockfile pins them. Best effort across the common lockfile formats. */
function lockedVersions(file: string, text: string, ecosystem: 'npm' | 'cargo', name: string): string[] {
  const found = new Set<string>();
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const lockfile = basename(file);
  if (ecosystem === 'npm' && lockfile === 'package-lock.json') {
    const packages = (JSON.parse(text) as { packages?: Record<string, { version?: string }> }).packages ?? {};
    for (const [path, info] of Object.entries(packages)) {
      if ((path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) && info.version)
        found.add(info.version);
    }
  } else if (ecosystem === 'npm' && lockfile === 'yarn.lock') {
    for (const match of text.matchAll(
      new RegExp(`^"?${escaped}@[^\\n]*:\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+version:? "?([^"\\n]+)"?`, 'gm'),
    )) {
      if (match[1]) found.add(match[1]);
    }
  } else if (ecosystem === 'npm' && lockfile === 'pnpm-lock.yaml') {
    for (const match of text.matchAll(new RegExp(`['"/]?${escaped}@(\\d+\\.\\d+\\.\\d+[^'":(\\s]*)`, 'g')))
      if (match[1]) found.add(match[1]);
  } else if (ecosystem === 'cargo' && lockfile === 'Cargo.lock') {
    for (const match of text.matchAll(new RegExp(`name = "${escaped}"\\nversion = "([^"]+)"`, 'g')))
      if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/** Runs the detect rules of the given entries over a directory. Rules are data: the engine knows rule kinds, not changes. */
export function checkDirectory(root: string, entries: Entry[]): Extract<CheckReport, { ok: true }> {
  const findings: Finding[] = [];
  const notRun: { entry: string; rule: string; reason: string }[] = [];
  const patterns: {
    entry: Entry;
    rule: Extract<DetectRule, { kind: 'code-pattern' }>;
    extensions: Set<string>;
    regex: RegExp;
  }[] = [];
  const lockRules: { entry: Entry; rule: Extract<DetectRule, { kind: 'lockfile-version' }> }[] = [];
  for (const entry of entries) {
    for (const rule of entry.detect) {
      if (rule.kind === 'code-pattern') {
        patterns.push({
          entry,
          rule,
          extensions: new Set(rule.languages.flatMap((language) => EXTENSIONS[language])),
          regex: new RegExp(rule.pattern),
        });
      } else if (rule.kind === 'lockfile-version') lockRules.push({ entry, rule });
      else
        notRun.push({
          entry: entry.id,
          rule: rule.rule,
          reason: 'runtime probes are not executed by a static check',
        });
    }
  }
  const fixesFor = (entry: Entry, rule: string) =>
    entry.fix
      .filter((fix) => fix.for_rules === undefined || fix.for_rules.includes(rule))
      .map((fix) => fix.summary);

  let filesScanned = 0;
  for (const path of walk(root)) {
    const file = relative(root, path);
    const matching = patterns.filter((item) => item.extensions.has(extname(path)));
    const locking = LOCKFILES.has(basename(path)) ? lockRules : [];
    if (matching.length === 0 && locking.length === 0) continue;
    const text = readFileSync(path, 'utf8');
    filesScanned += 1;
    if (matching.length > 0) {
      text.split('\n').forEach((content, index) => {
        for (const { entry, rule, regex } of matching) {
          if (!regex.test(content)) continue;
          findings.push({
            entry: entry.id,
            rev: entry.rev,
            rule: rule.rule,
            kind: rule.kind,
            confidence: rule.confidence,
            summary: rule.summary,
            file,
            line: index + 1,
            excerpt: content.trim().slice(0, 200),
            fix: fixesFor(entry, rule.rule),
          });
        }
      });
    }
    for (const { entry, rule } of locking) {
      let versions: string[];
      try {
        versions = lockedVersions(path, text, rule.package.ecosystem, rule.package.name);
      } catch {
        continue; // an unreadable lockfile is not a finding
      }
      const range =
        rule.package.ecosystem === 'cargo' ? rule.package.range.replaceAll(',', ' ') : rule.package.range;
      for (const version of versions.filter(
        (item) => semver.valid(item) !== null && semver.satisfies(item, range),
      )) {
        findings.push({
          entry: entry.id,
          rev: entry.rev,
          rule: rule.rule,
          kind: rule.kind,
          confidence: rule.confidence,
          summary: rule.summary,
          file,
          line: 0,
          excerpt: `${rule.package.name}@${version}`,
          fix: fixesFor(entry, rule.rule),
        });
      }
    }
  }
  return { ok: true, root, filesScanned, findings, notRun };
}

/** Checks a repository against every entry of a registry directory. */
export function checkRepository(root: string, registryPath: string): CheckReport {
  const registry = validatePath(registryPath);
  if (!registry.ok) {
    const issues = registry.files.flatMap((file) =>
      file.issues.map((issue) => ({ ...issue, path: `${file.file}: ${issue.path}` })),
    );
    return { ok: false, issues: [...issues, ...registry.registryIssues] };
  }
  return checkDirectory(
    root,
    registry.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry])),
  );
}
