import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { checkDirectory } from './check-repo.js';
import { validatePath } from './load.js';

/** Licences under which an excerpt may be copied into this repository, with attribution. */
const COPYABLE = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0'];

/** A plain file name: a case never reaches outside its own directory. */
const fileName = z.string().regex(/^[\w][\w.-]*$/);

const caseSchema = z.strictObject({
  id: z.string().regex(/^(real|synthetic)-[a-z0-9-]+$/),
  entry: z.string().min(1),
  files: z.strictObject({ before: fileName, after: fileName, as: fileName.optional() }),
  expect: z.strictObject({
    rule: z.string().min(1).optional(),
    confidence: z.enum(['breaks', 'check', 'likely-ok']),
  }),
  detected: z.boolean(),
  gap: z.string().min(1).optional(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('repository'),
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      /** Absent when the fix was committed without a pull request; the commits then say it alone. */
      pull_request: z.number().int().positive().optional(),
      path: z.string().min(1),
      before_commit: z.string().regex(/^[0-9a-f]{40}$/),
      after_commit: z.string().regex(/^[0-9a-f]{40}$/),
      license: z.enum(COPYABLE),
    }),
    z.strictObject({ kind: z.literal('synthetic'), reason: z.string().min(1) }),
  ]),
});
/** Code that looks like a case and is not one: every rule of the entry must stay silent on it. */
const quietSchema = z.strictObject({
  id: z.string().regex(/^quiet-[a-z0-9-]+$/),
  entry: z.string().min(1),
  file: fileName,
  reason: z.string().min(1),
});
const manifestSchema = z.strictObject({
  cases: z.array(caseSchema).min(1),
  quiet: z.array(quietSchema).default([]),
});

/** One case of the corpus manifest: where the code comes from and what a correct check reports on it. */
export type CorpusCase = z.infer<typeof caseSchema>;

/** What the engine reported on one case, against what it should. */
export interface CorpusRow {
  id: string;
  /** The registry entry the case is about; recall is also given per entry, since entries cover different chains. */
  entry: string;
  kind: 'repository' | 'synthetic';
  expected: string;
  /** What the engine reported on `before`, as `rule (confidence)`. */
  reported: string[];
  detected: boolean;
}

/** Where the manifest, the files and the engine disagree, and the recall of the engine on the corpus. */
export interface CorpusReport {
  problems: string[];
  rows: CorpusRow[];
  /** Samples that must not be reported, and whether they were left alone. */
  quiet: { id: string; silent: boolean }[];
  /** Of the cases a correct engine must report, how many today's engine does. */
  recall: { detected: number; of: number; repository: { detected: number; of: number } };
}

/**
 * Holds three things against each other: the manifest, the files of `corpus/pairs`, and the engine. A case
 * the manifest calls detected must be reported with the expected rule and confidence; a known miss must still
 * be missed, so that closing a gap is recorded and not just enjoyed; `after` must be silent for the entry.
 */
export function checkCorpus(corpusDir: string, registryDir: string): CorpusReport {
  const problems: string[] = [];
  const rows: CorpusRow[] = [];
  const registry = validatePath(registryDir);
  const entries = registry.files.flatMap((file) => (file.entry === undefined ? [] : [file.entry]));
  if (!registry.ok) problems.push('the registry is not valid: run `epochnotes registry validate`');

  const empty = {
    problems,
    rows,
    quiet: [],
    recall: { detected: 0, of: 0, repository: { detected: 0, of: 0 } },
  };
  if (!existsSync(join(corpusDir, 'manifest.yaml'))) {
    problems.push('there is no manifest.yaml');
    return empty;
  }
  const parsed = manifestSchema.safeParse(parse(readFileSync(join(corpusDir, 'manifest.yaml'), 'utf8')));
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      problems.push(`manifest ${issue.path.join('.')}: ${issue.message}`);
    return empty;
  }
  const cases = parsed.data.cases;
  const notice = existsSync(join(corpusDir, 'pairs', 'NOTICE.md'))
    ? readFileSync(join(corpusDir, 'pairs', 'NOTICE.md'), 'utf8')
    : '';

  // every directory has a case, every case a directory
  const onDisk = new Set<string>();
  for (const entry of readdirSync(join(corpusDir, 'pairs'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const item of readdirSync(join(corpusDir, 'pairs', entry.name), { withFileTypes: true }))
      if (item.isDirectory()) onDisk.add(`${entry.name}/${item.name}`);
  }
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) problems.push(`${item.id}: listed twice`);
    ids.add(item.id);
    if (!onDisk.delete(`${item.entry}/${item.id}`))
      problems.push(`${item.id}: no directory pairs/${item.entry}/${item.id}`);
  }
  for (const item of parsed.data.quiet) {
    if (ids.has(item.id)) problems.push(`${item.id}: listed twice`);
    ids.add(item.id);
    if (!onDisk.delete(`${item.entry}/${item.id}`))
      problems.push(`${item.id}: no directory pairs/${item.entry}/${item.id}`);
  }
  for (const orphan of onDisk) problems.push(`pairs/${orphan}: not in the manifest`);
  for (const item of cases) {
    const directory = join(corpusDir, 'pairs', item.entry, item.id);
    if (!existsSync(directory)) continue;
    const allowed = new Set([item.files.before, item.files.after]);
    for (const name of readdirSync(directory))
      if (!allowed.has(name)) problems.push(`${item.id}: ${name} is neither its before nor its after file`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'epochnotes-corpus-'));
  const quiet: { id: string; silent: boolean }[] = [];
  try {
    for (const item of parsed.data.quiet) {
      const entry = entries.find((candidate) => candidate.id === item.entry);
      const directory = join(corpusDir, 'pairs', item.entry, item.id);
      if (entry === undefined || !existsSync(join(directory, item.file))) {
        problems.push(`${item.id}: its entry or its file is missing`);
        continue;
      }
      for (const name of readdirSync(directory))
        if (name !== item.file) problems.push(`${item.id}: ${name} is not its sample file`);
      const target = join(scratch, item.id);
      cpSync(join(directory, item.file), join(target, item.file), { recursive: true });
      const checked = checkDirectory(target, [entry]);
      // a sample no rule reads is quiet for the wrong reason
      if (checked.filesScanned === 0)
        problems.push(`${item.id}: no rule of ${item.entry} reads ${item.file}`);
      const found = checked.findings;
      quiet.push({ id: item.id, silent: found.length === 0 });
      for (const finding of found)
        problems.push(
          `${item.id}: must stay silent, ${finding.rule} reports line ${finding.line}: ${finding.excerpt}`,
        );
    }
    for (const item of cases) {
      const entry = entries.find((candidate) => candidate.id === item.entry);
      const directory = join(corpusDir, 'pairs', item.entry, item.id);
      if (entry === undefined) {
        problems.push(`${item.id}: the registry has no entry ${item.entry}`);
        continue;
      }
      if (!existsSync(join(directory, item.files.before)) || !existsSync(join(directory, item.files.after))) {
        problems.push(`${item.id}: before or after file is missing`);
        continue;
      }
      const rule = entry.detect.find((candidate) => candidate.rule === item.expect.rule);
      if (item.expect.rule !== undefined && rule === undefined)
        problems.push(`${item.id}: ${item.entry} has no rule ${item.expect.rule}`);
      if (rule !== undefined && rule.confidence !== item.expect.confidence)
        problems.push(`${item.id}: expects ${item.expect.confidence}, the rule says ${rule.confidence}`);
      if (item.expect.rule === undefined && item.detected)
        problems.push(`${item.id}: detected without a rule to detect it`);
      if (!item.detected && item.gap === undefined) problems.push(`${item.id}: a known miss needs a gap`);
      if (item.detected && item.gap !== undefined)
        problems.push(`${item.id}: a detected case has no gap to explain`);
      if (item.id.startsWith('real-') !== (item.source.kind === 'repository'))
        problems.push(`${item.id}: the name and the kind of source disagree`);
      if (item.source.kind === 'repository') {
        if (item.source.before_commit === item.source.after_commit)
          problems.push(`${item.id}: before and after name the same commit`);
        // the cells of this case's row in the notice table, whatever padding a formatter gave them
        const row = (notice.split('\n').find((line) => line.includes(`\`${item.id}\``)) ?? '')
          .split('|')
          .map((cell) => cell.trim());
        if (
          !row.includes(`https://github.com/${item.source.repository}`) ||
          !row.includes(item.source.license)
        )
          problems.push(
            `${item.id}: pairs/NOTICE.md has no row with its repository and the licence ${item.source.license}`,
          );
        if (!existsSync(join(corpusDir, 'pairs', 'LICENSES', `${item.source.license}.txt`)))
          problems.push(`${item.id}: pairs/LICENSES/${item.source.license}.txt is missing`);
        if (!notice.includes(`https://github.com/${item.source.repository}`))
          problems.push(`${item.id}: ${item.source.repository} is not named in pairs/NOTICE.md`);
        for (const side of ['before', 'after'] as const) {
          const head = readFileSync(join(directory, item.files[side]), 'utf8')
            .split('\n')
            .slice(0, 4)
            .join('\n');
          const commit = item.source[`${side}_commit`].slice(0, 12);
          if (
            !head.includes(`Licensed under ${item.source.license} `) ||
            (item.source.pull_request !== undefined &&
              !head.includes(`pull request #${item.source.pull_request}.`))
          )
            problems.push(
              `${item.id}: the ${side} file does not name the licence and the pull request of the manifest`,
            );
          if (
            !head.includes(item.source.repository) ||
            !head.includes(commit) ||
            !head.includes(item.source.path)
          )
            problems.push(
              `${item.id}: the ${side} file does not name its repository, path and commit ${commit}`,
            );
        }
      }

      const run = (side: 'before' | 'after') => {
        const target = join(scratch, `${item.id}-${side}`);
        cpSync(join(directory, item.files[side]), join(target, item.files.as ?? item.files[side]), {
          recursive: true,
        });
        return checkDirectory(target, [entry]).findings;
      };
      const before = run('before');
      const hit = before.some(
        (finding) => finding.rule === item.expect.rule && finding.confidence === item.expect.confidence,
      );
      const reported = [...new Set(before.map((finding) => `${finding.rule} (${finding.confidence})`))];
      if (item.detected && !hit)
        problems.push(
          `${item.id}: expected ${item.expect.rule} on before, the engine reported ${reported.join(', ') || 'nothing'}`,
        );
      if (!item.detected && (item.expect.rule === undefined ? before.length > 0 : hit))
        problems.push(
          `${item.id}: recorded as a miss, but the engine now reports ${reported.join(', ')}: update the manifest`,
        );
      const unexpected = before.filter((finding) => finding.rule !== item.expect.rule);
      if (unexpected.length > 0 && item.expect.rule !== undefined)
        problems.push(
          `${item.id}: before is also reported by ${[...new Set(unexpected.map((finding) => finding.rule))].join(', ')}, which the manifest does not expect`,
        );
      const after = run('after');
      if (after.length > 0)
        problems.push(
          `${item.id}: after must be silent, the engine reported ${after.map((finding) => finding.rule).join(', ')}`,
        );
      rows.push({
        id: item.id,
        entry: item.entry,
        kind: item.source.kind,
        expected: `${item.expect.rule ?? 'no rule yet'} (${item.expect.confidence})`,
        reported,
        detected: item.detected,
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const count = (list: CorpusRow[]) => ({
    detected: list.filter((row) => row.detected).length,
    of: list.length,
  });
  return {
    problems,
    rows,
    quiet,
    recall: { ...count(rows), repository: count(rows.filter((row) => row.kind === 'repository')) },
  };
}
