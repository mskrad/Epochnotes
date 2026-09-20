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
/** Source files above this are generated bundles, not code somebody maintains; they are reported, not read. */
const MAX_FILE_BYTES = 1024 * 1024;
/**
 * Lockfiles are generated too, but they are the only place a dependency version can be read from. Of 95
 * lockfiles in the field corpus three were above one MiB, the largest 1.5 MiB; monorepos grow well past that.
 */
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;

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
  reason:
    | 'symlink-outside-root'
    | 'broken-symlink'
    | 'symlink-target-not-scanned'
    | 'unreadable'
    | 'too-large'
    | 'unparsable-lockfile';
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
function* walk(root: string, skipped: Skipped[], directory = root): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    skipped.push({ file: relative(root, directory), reason: 'unreadable' });
    return;
  }
  for (const name of names) {
    const path = join(directory, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      skipped.push({ file: relative(root, path), reason: 'unreadable' });
      continue;
    }
    // A link is resolved whatever its name: one called node_modules can point anywhere.
    if (stats.isSymbolicLink()) yield path;
    else if (SKIPPED_DIRECTORIES.has(name)) continue;
    else if (stats.isDirectory()) yield* walk(root, skipped, path);
    else if (stats.isFile()) yield path;
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
 *
 * A link does not widen what is checked inside the root either: its target is read only if it is a file the
 * scan covers anyway (tracked, or outside the directories skipped by name). A link to an ignored `.env.ts` is
 * reported as skipped, not read.
 *
 * Not covered: hard links, which cannot be told from the file itself, and a path swapped between resolving and
 * reading. The scanner is not a sandbox; run it with the rights you would give the repository's own scripts.
 */
function sourceFiles(root: string): {
  realRoot: string;
  /** `names`: the file's own name and the names of links to it; a lockfile is recognised by any of them. */
  files: { path: string; bytes: number; names: string[] }[];
  skipped: Skipped[];
} {
  const realRoot = realpathSync(root);
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  const skipped: Skipped[] = [];
  let candidates: string[];
  let tracked = true;
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
    tracked = false;
    candidates = [...walk(realRoot, skipped)];
  }
  const files = new Map<string, number>();
  const aliases: { file: string; real: string }[] = [];
  const names = new Map<string, string[]>();
  for (const path of candidates.sort()) {
    const file = relative(realRoot, path);
    let real: string;
    try {
      real = realpathSync(path);
    } catch (error) {
      // A tracked file deleted from the work tree is not worth a word; anything else that cannot be resolved is.
      const code = (error as NodeJS.ErrnoException).code;
      let link = false;
      try {
        link = lstatSync(path).isSymbolicLink();
      } catch {
        link = false;
      }
      if (link) skipped.push({ file, reason: 'broken-symlink' });
      else if (code !== 'ENOENT') skipped.push({ file, reason: 'unreadable' });
      continue;
    }
    if (real !== realRoot && !real.startsWith(prefix)) {
      skipped.push({ file, reason: 'symlink-outside-root' });
      continue;
    }
    if (real !== path) {
      aliases.push({ file, real });
      continue;
    }
    let stats;
    try {
      stats = statSync(real);
    } catch {
      skipped.push({ file, reason: 'unreadable' });
      continue;
    }
    if (stats.isFile()) files.set(real, stats.size);
  }
  // A path reached through a link inside the root: fine when the scan covers its target anyway, which includes
  // every link to a directory. Otherwise the link would widen the scan, so it is reported instead.
  for (const { file, real } of aliases) {
    let directory = false;
    try {
      directory = statSync(real).isDirectory();
    } catch {
      directory = false;
    }
    // Outside git a directory is left out by its name, so a link into one leads nowhere the scan goes.
    const leftOut =
      !tracked &&
      relative(realRoot, real)
        .split(sep)
        .some((part) => SKIPPED_DIRECTORIES.has(part));
    if (directory ? leftOut : !files.has(real)) skipped.push({ file, reason: 'symlink-target-not-scanned' });
    else if (!directory) names.set(real, [...(names.get(real) ?? []), basename(file)]);
  }
  const sorted = [...files]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, bytes]) => ({ path, bytes, names: [basename(path), ...(names.get(path) ?? [])] }));
  return { realRoot, files: sorted, skipped };
}

class UnparsableLockfile extends Error {}

/** The lockfile names, by the format they are read as. */
const LOCKFILE_FORMAT: Record<string, 'package-lock' | 'yarn' | 'pnpm' | 'cargo'> = {
  'package-lock.json': 'package-lock',
  'npm-shrinkwrap.json': 'package-lock',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'Cargo.lock': 'cargo',
};

/**
 * Versions of one package as the lockfile pins them, across the common lockfile formats. Throws
 * `UnparsableLockfile` when the text does not look like that kind of lockfile: "no version found" must mean
 * that the package is not there, not that the file could not be read.
 *
 * A repository is somebody else's data, and a lockfile can be written to make a careless regular expression
 * run for hours. Every parser here goes through the file line by line, and every expression is applied to one
 * line and cannot match across lines, so the work grows with the size of the file and no faster.
 */
function lockedVersions(lockfile: string, raw: string, name: string): string[] {
  const found = new Set<string>();
  const text = raw
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n');
  const format = LOCKFILE_FORMAT[lockfile];
  if (format === 'package-lock') {
    interface Tree {
      version?: unknown;
      dependencies?: unknown;
    }
    const isObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    let lock: unknown;
    try {
      lock = JSON.parse(text);
    } catch {
      throw new UnparsableLockfile();
    }
    if (!isObject(lock) || (!isObject(lock.packages) && !isObject(lock.dependencies)))
      throw new UnparsableLockfile();
    for (const [path, info] of Object.entries(isObject(lock.packages) ? lock.packages : {})) {
      if (!isObject(info) || typeof info.version !== 'string') continue;
      if (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)) found.add(info.version);
    }
    // The first lockfile format keeps a tree of dependencies instead of a flat list of paths.
    const pending: unknown[] = [lock.dependencies];
    for (let tree = pending.pop(); pending.length > 0 || tree !== undefined; tree = pending.pop()) {
      if (!isObject(tree)) continue;
      for (const [dependency, info] of Object.entries(tree)) {
        if (!isObject(info)) continue;
        const node = info as Tree;
        if (dependency === name && typeof node.version === 'string') found.add(node.version);
        if (node.dependencies !== undefined) pending.push(node.dependencies);
      }
    }
  } else if (format === 'yarn') {
    // Classic: `"name@range", name@range:` then `  version "1.2.3"`. Berry: `"name@npm:range":` then `  version: 1.2.3`.
    let looksLikeYarn = false;
    let inBlock = false;
    for (const line of text.split('\n')) {
      if (line.startsWith('# yarn lockfile') || line.startsWith('__metadata:')) looksLikeYarn = true;
      if (line === '' || line.startsWith('#')) continue;
      if (line[0] !== ' ' && line[0] !== '\t') {
        inBlock = line
          .replace(/:$/, '')
          .split(',')
          .some((spec) => spec.trim().replace(/^"|"$/g, '').startsWith(`${name}@`));
        continue;
      }
      const version = /^[ \t]+version:? "?([^"\s]+)"?[ \t]*$/.exec(line)?.[1];
      if (version === undefined) continue;
      looksLikeYarn = true;
      if (inBlock) found.add(version);
      inBlock = false;
    }
    if (!looksLikeYarn) throw new UnparsableLockfile();
  } else if (format === 'pnpm') {
    // Keys of the package list: `/name/1.2.3:` and `/name/1.2.3_peers:` (older), `/name@1.2.3(peers):`,
    // `'name@1.2.3(peers)':` (newer). The name must be followed by its separator, so a longer name is not taken.
    let looksLikePnpm = false;
    for (const line of text.split('\n')) {
      if (/^(lockfileVersion|packages|importers|snapshots):/.test(line)) looksLikePnpm = true;
      const key = line.trimStart().replace(/^['"]/, '').replace(/^\//, '');
      if (!key.startsWith(name)) continue;
      const version = /^[@/](\d+\.\d+\.\d+[^'":(_\s]*)/.exec(key.slice(name.length))?.[1];
      if (version !== undefined) found.add(version);
    }
    if (!looksLikePnpm) throw new UnparsableLockfile();
  } else if (format === 'cargo') {
    if (!text.includes('[[package]]')) throw new UnparsableLockfile();
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const version = /^version = "([^"]+)"$/.exec(lines[index + 1] ?? '')?.[1];
      if (line === `name = "${name}"` && version !== undefined) found.add(version);
    });
  }
  return [...found];
}

/**
 * Tells whether a position in a file is commented out: inside a block comment, or on a line that is a line
 * comment from its start. Code after a comment closes on the same line is code; so is a line that starts with
 * a star because it multiplies or dereferences. A comment after code on the same line, and a string, are not
 * told apart and stay reported. Documentation is not code: for markdown nothing is a comment.
 */
function commentedOut(
  extension: string,
  text: string,
  lineStarts: number[],
): (offset: number, line: number) => boolean {
  if (EXTENSIONS.markdown.includes(extension)) return () => false;
  const lineComment = EXTENSIONS.python.includes(extension) ? '#' : '//';
  const blocks: [number, number][] = [];
  if (lineComment === '//') {
    // An opening counts only where a comment can start: not inside a word or a path such as src/*.ts.
    const opening = /(^|[\s;{}(),])\/\*/gm;
    for (let open = opening.exec(text); open !== null; open = opening.exec(text)) {
      const start = open.index + (open[1] ?? '').length;
      const close = text.indexOf('*/', start + 2);
      const end = close === -1 ? text.length : close + 2;
      blocks.push([start, end]);
      opening.lastIndex = end;
    }
  }
  return (offset, line) => {
    const start = lineStarts[line] as number;
    if (text.slice(start, offset).trimStart().startsWith(lineComment)) return true;
    // few blocks per file; a linear look is enough
    return blocks.some(([from, to]) => offset >= from && offset < to);
  };
}

export interface CheckLimits {
  maxFileBytes?: number;
  maxLockfileBytes?: number;
}

/** Runs the detect rules of the given entries over a directory. Rules are data: the engine knows rule kinds, not changes. */
export function checkDirectory(
  root: string,
  entries: Entry[],
  limits: CheckLimits = {},
): Extract<CheckReport, { ok: true }> {
  const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const maxLockfileBytes = limits.maxLockfileBytes ?? MAX_LOCKFILE_BYTES;
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
          // Over the whole text, so that a line break inside the match does not hide it; `m` keeps ^ and $ meaning
          // a line, as they did when patterns ran line by line.
          regex: new RegExp(rule.pattern, 'gm'),
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
  for (const { path, bytes, names } of files) {
    const file = relative(realRoot, path);
    const matching = patterns.filter((item) => item.extensions.has(extname(path)));
    // A lockfile by any name it is reached under — but a link named like a lockfile that points at source code
    // is source code: it is read by the patterns, under the limit for source files.
    const lockfile = matching.length > 0 ? undefined : names.find((name) => name in LOCKFILE_FORMAT);
    // Only the rules of the ecosystem the lockfile belongs to: a Cargo.lock says nothing about npm packages.
    const ecosystem = lockfile === 'Cargo.lock' ? 'cargo' : 'npm';
    const locking =
      lockfile === undefined ? [] : lockRules.filter(({ rule }) => rule.package.ecosystem === ecosystem);
    if (matching.length === 0 && locking.length === 0) continue;
    // Only a file that a rule would have read is worth a word when it is left out.
    if (bytes > (lockfile === undefined ? maxFileBytes : maxLockfileBytes)) {
      skipped.push({ file, reason: 'too-large' });
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      skipped.push({ file, reason: 'unreadable' });
      continue;
    }
    const inFile: (Finding & { order: number })[] = [];
    let covered = matching.length > 0;
    if (matching.length > 0) {
      // A pattern never sees a carriage return: one that spells out a line break matches Windows files too, and
      // no excerpt carries one. Removing them leaves the number of every line as it was.
      const text = raw.replaceAll('\r\n', '\n');
      const lineStarts = [0];
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
      const lineOf = (offset: number) => {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low < high) {
          const middle = (low + high + 1) >> 1;
          if ((lineStarts[middle] as number) <= offset) low = middle;
          else high = middle - 1;
        }
        return low;
      };
      const lineText = (line: number) =>
        text.slice(lineStarts[line], (lineStarts[line + 1] ?? text.length + 1) - 1).trim();
      const isComment = commentedOut(extname(path), text, lineStarts);
      matching.forEach(({ entry, rule, regex }, order) => {
        let lastLine = -1;
        regex.lastIndex = 0;
        for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
          if (match[0] === '') regex.lastIndex += 1; // an empty match must not loop forever
          const line = lineOf(match.index);
          if (line === lastLine) continue; // one finding for a line and a rule, as before
          // Commented-out code does not run.
          if (isComment(match.index, line)) continue;
          lastLine = line;
          const last = lineOf(match.index + Math.max(match[0].length - 1, 0));
          let excerpt = lineText(line).slice(0, 200);
          if (last > line) {
            // A match over several lines: both of its ends must stay in sight, whatever lies between them and
            // however long the lines are. The first piece starts shortly before the match, the last one ends
            // shortly after it.
            const end = match.index + match[0].length;
            const head = text.slice(
              Math.max(lineStarts[line] as number, match.index - 80),
              lineStarts[line + 1],
            );
            const tail = text.slice(lineStarts[last], end + 40).split('\n')[0] ?? '';
            const middle =
              last - line <= 4
                ? Array.from({ length: last - line - 1 }, (_, index) =>
                    lineText(line + 1 + index).slice(0, 120),
                  )
                : ['\u2026'];
            excerpt = [head.trim().slice(-120), ...middle, tail.trim().slice(0, 120)].join(' \u23ce ');
          }
          inFile.push({
            order,
            entry: entry.id,
            rev: entry.rev,
            rule: rule.rule,
            kind: rule.kind,
            confidence: rule.confidence,
            summary: rule.summary,
            file,
            line: line + 1,
            excerpt,
            fix: fixesFor(entry, rule.rule),
          });
        }
      });
    }
    for (const { entry, rule } of locking) {
      let versions: string[];
      try {
        versions = lockedVersions(lockfile as string, raw, rule.package.name);
        covered = true;
      } catch (error) {
        if (!(error instanceof UnparsableLockfile)) throw error;
        // Not a finding, and not silence either: nothing is known about the packages of this project.
        if (!skipped.some((item) => item.file === file))
          skipped.push({ file, reason: 'unparsable-lockfile' });
        continue;
      }
      const range =
        rule.package.ecosystem === 'cargo' ? rule.package.range.replaceAll(',', ' ') : rule.package.range;
      for (const version of versions.filter(
        (item) => semver.valid(item) !== null && semver.satisfies(item, range),
      )) {
        inFile.push({
          order: patterns.length,
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
    if (covered) filesScanned += 1;
    // In the order of the lines of the file; rules in the order of the registry on the same line.
    inFile.sort((a, b) => a.line - b.line || a.order - b.order);
    for (const { order, ...finding } of inFile) {
      void order;
      findings.push(finding);
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
