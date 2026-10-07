import { isAddress } from '@solana/addresses';
import semver from 'semver';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { z } from 'zod';

import { SOLANA_CHAINS } from './chains.js';
import { DRAFT_MARKER, readsAsDraft } from './watch.js';
import {
  activationsOf,
  type Entry,
  entrySchemaV1,
  entrySchemaV2,
  PROBE_CLUSTERS,
  PROBE_METHODS,
  READABLE_SCHEMA_VERSIONS,
  subjectOf,
} from './schema.js';

/** One validation problem: where it is, what is wrong, and what to do about it. */
export interface Issue {
  /** Stable identifier for problems that code reacts to; absent for plain schema violations. */
  code?: 'unresolved-relation' | 'duplicate-id' | 'relation-cycle' | 'slow-pattern';
  path: string;
  message: string;
  hint: string;
}

/** A valid entry with its defaults filled in, or every issue found in it. */
export type ValidationResult = { ok: true; entry: Entry; issues: [] } | { ok: false; issues: Issue[] };

/** A `YYYY-MM-DD` string that is also a real calendar date. */
function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Cargo separates comparators with commas where npm uses spaces; the comparators themselves agree. */
function isVersionRange(ecosystem: string, range: string): boolean {
  return semver.validRange(ecosystem === 'cargo' ? range.replaceAll(',', ' ') : range) !== null;
}

const STATUS_KEYS = /^(status|state|activated|activated_at|activated_slot|activation|active|is_active)$/i;

function formatPath(path: PropertyKey[]): string {
  return path
    .map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`))
    .join('')
    .replace(/^\./, '');
}

function hintFor(issue: z.core.$ZodIssue, rawVersion?: unknown): string {
  const field = String(issue.path.at(-1) ?? '');
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.some((key) => STATUS_KEYS.test(key))
      ? 'Remove it: activation status is never stored in an entry, it is read from the chain at check time.'
      : 'Remove the field or check its spelling against registry/schema.json.';
  }
  if (issue.code === 'too_small' && field === 'sources') {
    return 'Add at least one source with kind, ref and retrieved (YYYY-MM-DD): every claim must be traceable.';
  }
  if (issue.code === 'invalid_type' && field === 'sources') {
    return 'Add a sources list with at least one item: kind, ref and retrieved (YYYY-MM-DD).';
  }
  if (issue.code === 'too_small' && (field === 'gates' || field === 'activations' || field === 'versions')) {
    return 'List at least one item, or remove the empty list.';
  }
  if (field === 'applies')
    return rawVersion === 1
      ? 'Add applies.gates (feature gate addresses) and/or applies.versions (semver ranges).'
      : 'Add applies.activations (where and how the change activates, per chain) and/or applies.versions (semver ranges).';
  if (field === 'chain')
    return 'Name the chain by its CAIP-2 id: solana for a Solana feature account, eip155:<chain id> for an EVM fork by time, <namespace>:<reference> for a block height.';
  if (field === 'address') return 'Copy the feature account address, in base58, from the client source code.';
  if (issue.code === 'invalid_type' && issue.expected === 'int')
    return 'Use a whole number; fractional numbers are not allowed in entries.';
  if (field === 'retrieved') return 'Add retrieved: the date the source was read, as YYYY-MM-DD.';
  if (field === 'equals')
    return 'Compare with a string, a whole number or true/false; an entry holds no null, and a missing value is not a behaviour to pass on.';
  if (field === 'method' && issue.path.includes('calls'))
    return `A probe only reads: use one of ${PROBE_METHODS.join(', ')}.`;
  if (field === 'fixture')
    return `Name the chain the transaction lives on and its signature, as <chain>:<signature>. In schema_version 2 the chain is a CAIP-2 id, one of ${Object.values(SOLANA_CHAINS).join(', ')}; in schema_version 1 it is one of ${PROBE_CLUSTERS.join(', ')}. A probe runs only against an endpoint that serves that chain, so a chain no endpoint is recognised by would be probed on every endpoint that could not be placed.`;
  if (issue.code === 'invalid_type' && issue.input === undefined) return `Add the required field "${field}".`;
  return 'See registry/schema.json for the expected shape of this field.';
}

function semanticIssues(entry: Entry): Issue[] {
  const issues: Issue[] = [];
  const rules = new Set<string>();

  entry.detect.forEach((rule, index) => {
    const at = `detect[${index}]`;
    if (rules.has(rule.rule)) {
      issues.push({
        path: `${at}.rule`,
        message: `Duplicate rule "${rule.rule}"`,
        hint: 'Rule names must be unique within an entry.',
      });
    }
    rules.add(rule.rule);
    if (rule.kind === 'code-pattern') {
      // Patterns are executed by this engine (JavaScript) whatever language they search, so that is the dialect checked.
      try {
        new RegExp(rule.pattern);
        const slow = slowPatternInput(rule.pattern);
        if (slow !== undefined)
          issues.push({
            code: 'slow-pattern',
            path: `${at}.pattern`,
            message: `Pattern takes too long on ${slow}: it is run over whole files of up to one MiB`,
            hint: 'Bound what may cross lines: use [^\\n]* or a counted repetition such as [^;]{0,400} instead of an open-ended negated class.',
          });
      } catch (error) {
        issues.push({
          path: `${at}.pattern`,
          message: `Pattern does not compile: ${(error as Error).message}`,
          hint: 'Fix the regular expression.',
        });
      }
    }
    if (rule.kind === 'runtime-probe' && 'calls' in rule.probe) {
      const ids = new Set<string>();
      rule.probe.calls.forEach((call, index) => {
        if (ids.has(call.id))
          issues.push({
            path: `${at}.probe.calls[${index}].id`,
            message: `Duplicate call id "${call.id}"`,
            hint: 'Every call of a probe has its own id: the pass conditions name calls by it.',
          });
        ids.add(call.id);
      });
      rule.probe.pass.forEach((condition, index) => {
        if (!ids.has(condition.call))
          issues.push({
            path: `${at}.probe.pass[${index}].call`,
            message: `No call with the id "${condition.call}"`,
            hint: `A pass condition names one of the probe's calls: ${[...ids].join(', ')}.`,
          });
      });
      if (!rule.probe.calls.some((call) => call.params.includes('$fixture')))
        issues.push({
          path: `${at}.probe.calls`,
          message: 'No call reads the fixture',
          hint: 'Put the string $fixture where the transaction id goes; a probe that does not read its fixture observes nothing about it.',
        });
    }
    if (rule.kind === 'lockfile-version' && !isVersionRange(rule.package.ecosystem, rule.package.range)) {
      issues.push({
        path: `${at}.package.range`,
        message: `"${rule.package.range}" is not a semver range`,
        hint: 'Use a range such as "<8.0.0" or ">=1.2.0 <2.0.0".',
      });
    }
  });

  // A draft written by the watcher is not an entry until a person replaces every marker with what the source says.
  [
    ...entry.breaks.map((item, index) => [`breaks[${index}].summary`, item.summary] as const),
    ...entry.fix.map((item, index) => [`fix[${index}].summary`, item.summary] as const),
    ['subject.title', subjectOf(entry).title ?? ''] as const,
  ].forEach(([path, summary]) => {
    if (readsAsDraft(summary))
      issues.push({
        path,
        message: 'Entry is a draft written by the watcher',
        hint: `Write what the primary source says, add it to sources, and remove every ${DRAFT_MARKER} marker.`,
      });
  });
  if (subjectOf(entry).standard === 'simd' && !entry.sources.some((source) => source.kind === 'simd'))
    issues.push({
      path: 'sources',
      message: `Entry about ${subjectOf(entry).name} does not cite the SIMD`,
      hint: 'Add the SIMD as a source: kind: simd, ref: its file in solana-improvement-documents at a commit.',
    });
  const activations = entry.schema_version === 2 ? 'activations' : 'gates';
  activationsOf(entry).forEach((gate, index) => {
    if (gate.kind === 'feature-account' && !isAddress(gate.address)) {
      issues.push({
        path: `applies.${activations}[${index}].address`,
        message: `"${gate.address}" is not a 32-byte base58 address`,
        hint: 'Copy the feature gate address from the client source code.',
      });
    }
  });
  entry.applies.versions?.forEach((item, index) => {
    if (!isVersionRange(item.ecosystem, item.range)) {
      issues.push({
        path: `applies.versions[${index}].range`,
        message: `"${item.range}" is not a semver range`,
        hint: 'Use a range such as ">=4.2.0".',
      });
    }
  });

  entry.sources.forEach((source, index) => {
    if (!isCalendarDate(source.retrieved)) {
      issues.push({
        path: `sources[${index}].retrieved`,
        message: `"${source.retrieved}" is not a calendar date`,
        hint: 'Use the real date the source was read, as YYYY-MM-DD.',
      });
    }
  });

  entry.breaks.forEach((item, index) => {
    item.evidence?.forEach((sourceIndex, position) => {
      if (sourceIndex >= entry.sources.length) {
        issues.push({
          path: `breaks[${index}].evidence[${position}]`,
          message: `No source with index ${sourceIndex}`,
          hint: `sources has ${entry.sources.length} item(s); evidence indexes start at 0.`,
        });
      }
    });
  });
  entry.fix.forEach((item, index) => {
    item.for_rules?.forEach((name, position) => {
      if (!rules.has(name)) {
        issues.push({
          path: `fix[${index}].for_rules[${position}]`,
          message: `No detect rule named "${name}"`,
          hint: 'Reference an existing detect[].rule or remove the reference.',
        });
      }
    });
  });
  entry.relations.forEach((relation, index) => {
    if (relation.id === entry.id) {
      issues.push({
        path: `relations[${index}].id`,
        message: 'An entry cannot relate to itself',
        hint: 'Point to another entry id.',
      });
    }
  });
  return issues;
}

const PROBE_BYTES = 192 * 1024;
const PROBE_BUDGET_MS = 400;

/**
 * The literal stretches of a pattern, unescaped, with the simplest stand-in for what is not literal: a blank
 * for \s, a digit for \d, a tab for \t, the first member for a class of alternatives such as [gG]. A
 * quantifier does not end a stretch, so `await\s+conn\.getBlock\(` gives `await conn.getBlock(`.
 */
function literalsOf(pattern: string): string[] {
  const found: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length >= 2) found.push(current);
    current = '';
  };
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at] as string;
    if (char === '\\' && at + 1 < pattern.length) {
      const next = pattern[at + 1] as string;
      at += 1;
      if (next === 's') current += ' ';
      else if (next === 'd') current += '0';
      else if (next === 't') current += '\t';
      else if (/[A-Za-z0-9]/.test(next)) flush();
      else current += next;
    } else if (char === '[' && pattern[at + 1] !== '^') {
      const close = pattern.indexOf(']', at);
      const first = pattern[at + 1];
      if (close === -1 || first === undefined || first === '\\') flush();
      else current += first;
      if (close !== -1) at = close;
    } else if (/[+*?]/.test(char)) {
      // a quantifier keeps the stretch going
    } else if (/[\w"'\s,:=<>.-]/.test(char)) current += char;
    else flush();
  }
  flush();
  return found;
}

/**
 * A pattern is matched against whole files, so one that rescans the rest of the file from every start is
 * quadratic: harmless line by line, minutes on a large file. The probe runs the pattern over texts built to
 * provoke that — every literal stretch of the pattern itself and every word of it, repeated, bare and followed
 * by each kind of opening bracket, and long runs of blanks, tabs, digits and line breaks — and reports the
 * first one that blows the budget. A linear pattern needs a few milliseconds.
 *
 * It is a net, not a proof: a pattern can be slow on a text the probe did not think of. And it cannot stop a
 * single match attempt that never returns: an exponential pattern hangs the validation of the publisher who
 * wrote it, which is a loud failure on the right desk.
 */
export function slowPatternInput(pattern: string): string | undefined {
  const words = pattern.match(/[A-Za-z_]{2,}/g) ?? [];
  const stems = [...new Set([...literalsOf(pattern), ...words, ...words.map((word) => `.${word}`)])].slice(
    0,
    32,
  );
  const tails = ['', '(', ' {', ': {', '"', '[', '<', ' => {', '='];
  const units = stems.flatMap((stem) => tails.map((tail) => `${stem}${tail}`));
  const started = performance.now();
  for (const unit of [...units, ' ', '\n', '\t', '0', 'a']) {
    // The run ends in another character: a pattern anchored after the run then fails, and starts again one
    // character later.
    const text = `${unit.repeat(Math.ceil(PROBE_BYTES / unit.length))}\u0001`;
    const regex = new RegExp(pattern, 'gm');
    const probeStarted = performance.now();
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (match[0] === '') regex.lastIndex += 1;
      if (performance.now() - probeStarted > PROBE_BUDGET_MS) break;
    }
    if (performance.now() - probeStarted > PROBE_BUDGET_MS)
      return `${JSON.stringify(unit.length > 40 ? `${unit.slice(0, 40)}…` : unit)} repeated`;
    // the probing of one pattern stays short, whatever the number of units
    if (performance.now() - started > 30 * PROBE_BUDGET_MS) return undefined;
  }
  return undefined;
}

/** Validates one parsed entry: shape first, then the checks a schema cannot express. */
export function validateEntry(raw: unknown): ValidationResult {
  // The format decides the schema; parsing against the right one gives errors at the right field instead of
  // a union's "invalid input".
  const version =
    typeof raw === 'object' && raw !== null
      ? (raw as { schema_version?: unknown }).schema_version
      : undefined;
  if (!READABLE_SCHEMA_VERSIONS.includes(version as 1 | 2)) {
    return {
      ok: false,
      issues: [
        {
          path: 'schema_version',
          message:
            version === undefined
              ? 'Missing schema_version'
              : `Unsupported schema_version ${JSON.stringify(version)}`,
          hint: `This reader knows schema_version ${READABLE_SCHEMA_VERSIONS.join(' and ')}; write new entries in ${READABLE_SCHEMA_VERSIONS.at(-1)}. An entry from a newer format needs a newer epochnotes.`,
        },
      ],
    };
  }
  const parsed = (version === 1 ? entrySchemaV1 : entrySchemaV2).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
        hint: hintFor(issue, version),
      })),
    };
  }
  const issues = semanticIssues(parsed.data);
  return issues.length === 0 ? { ok: true, entry: parsed.data, issues: [] } : { ok: false, issues };
}

/** Parses entry YAML and validates it. Duplicate keys and YAML syntax errors are reported as issues. */
export function validateEntryYaml(source: string): ValidationResult {
  let raw: unknown;
  try {
    raw = parseYaml(source, { schema: 'core', uniqueKeys: true, prettyErrors: true });
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    return {
      ok: false,
      issues: [
        {
          path: `line ${error.linePos?.[0].line ?? '?'}`,
          message: error.message.split('\n')[0] ?? error.message,
          hint: 'Fix the YAML syntax.',
        },
      ],
    };
  }
  return validateEntry(raw);
}

/** Checks that span entries: unique ids, relations that resolve, no requires/supersedes cycles. */
export function validateRegistry(entries: Entry[]): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      issues.push({
        path: entry.id,
        message: `Duplicate entry id "${entry.id}"`,
        hint: 'An id is stable and unique; edits raise rev instead of adding a second entry.',
      });
    }
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    entry.relations.forEach((relation, index) => {
      if (!byId.has(relation.id)) {
        issues.push({
          code: 'unresolved-relation',
          path: `${entry.id}.relations[${index}].id`,
          message: `No entry with id "${relation.id}"`,
          hint: 'Add the related entry to the registry or fix the id.',
        });
      }
    });
  }
  // Each relation type is its own graph: "a requires b" together with "b supersedes a" is not a cycle.
  for (const type of ['requires', 'supersedes'] as const) {
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') {
        issues.push({
          path: id,
          message: `Cycle in "${type}": ${[...trail, id].join(' -> ')}`,
          hint: `Remove one of the "${type}" relations in the cycle.`,
        });
        return;
      }
      state.set(id, 'visiting');
      for (const relation of byId.get(id)?.relations ?? [])
        if (relation.type === type) visit(relation.id, [...trail, id]);
      state.set(id, 'done');
    };
    for (const id of byId.keys()) visit(id, []);
  }
  return issues;
}
