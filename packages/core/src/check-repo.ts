import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';

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
/** Used only when the directory is not a git work tree: names that are dependencies or VCS data everywhere. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);
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

export interface Skipped {
  /** Path relative to the scanned directory, as it is named there. */
  file: string;
  reason: 'symlink-outside-root' | 'broken-symlink';
}

export type CheckReport =
  | {
      ok: true;
      root: string;
      filesScanned: number;
      findings: Finding[];
      /** Paths that were not read, and why. A path missing from both the findings and this list was checked. */
      skipped: Skipped[];
      notRun: { entry: string; rule: string; reason: string }[];
    }
  | { ok: false; issues: Issue[] };

/**
 * Candidate paths outside git. A link is yielded as a path and never descended into: what it points to is
 * decided in one place, `sourceFiles`, and a directory inside the root is reached under its real name anyway —
 * which also ends every cycle of links.
 */
function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory).sort()) {
    if (SKIPPED_DIRECTORIES.has(name)) continue;
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) yield* walk(path);
    else if (stats.isFile() || stats.isSymbolicLink()) yield path;
  }
}

/**
 * The files to check, by their real paths. In a git work tree these are the tracked files: that leaves out
 * dependencies and build output without guessing directory names — a guess such as "build" once hid
 * `skills/build/...`.
 *
 * Nothing outside the root is ever read. A repository is somebody else's data: a link in it — a tracked link,
 * or a tracked path that runs through a linked directory — may point at any file this process can open, and a
 * line of that file would end up in a finding. Every path is resolved first; a path that resolves outside the
 * root is reported as skipped, and a file reached twice is read once, under its real name.
 */
function sourceFiles(root: string): { realRoot: string; files: string[]; skipped: Skipped[] } {
  const realRoot = realpathSync(root);
  let candidates: string[];
  try {
    const listed = execFileSync('git', ['-C', realRoot, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    candidates = listed
      .split('\0')
      .filter(Boolean)
      .map((file) => join(realRoot, file));
  } catch {
    candidates = [...walk(realRoot)];
  }
  const files = new Set<string>();
  const skipped: Skipped[] = [];
  for (const path of candidates.sort()) {
    const file = relative(realRoot, path);
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      // A link to nothing is worth a word; a tracked file deleted from the work tree is not.
      let link = false;
      try {
        link = lstatSync(path).isSymbolicLink();
      } catch {
        link = false;
      }
      if (link) skipped.push({ file, reason: 'broken-symlink' });
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      skipped.push({ file, reason: 'symlink-outside-root' });
      continue;
    }
    // A link to a directory inside the root: its files are candidates under their real names already.
    const stats = statSync(real);
    if (stats.isFile() && stats.size <= MAX_FILE_BYTES) files.add(real);
  }
  return { realRoot, files: [...files].sort(), skipped };
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
  const { realRoot, files, skipped } = sourceFiles(root);
  for (const path of files) {
    const file = relative(realRoot, path);
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
  return { ok: true, root, filesScanned, findings, skipped, notRun };
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
