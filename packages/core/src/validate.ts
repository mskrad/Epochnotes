import { isAddress } from '@solana/addresses';
import semver from 'semver';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import type { z } from 'zod';

import { type Entry, entrySchema } from './schema.js';

/** One validation problem: where it is, what is wrong, and what to do about it. */
export interface Issue {
  path: string;
  message: string;
  hint: string;
}

export type ValidationResult = { ok: true; entry: Entry; issues: [] } | { ok: false; issues: Issue[] };

const STATUS_KEYS = /^(status|state|activated|activated_at|activated_slot|activation|active|is_active)$/i;

function formatPath(path: PropertyKey[]): string {
  return path
    .map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`))
    .join('')
    .replace(/^\./, '');
}

function hintFor(issue: z.core.$ZodIssue): string {
  const field = String(issue.path.at(-1) ?? '');
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.some((key) => STATUS_KEYS.test(key))
      ? 'Remove it: activation status is never stored in an entry, it is read from the feature gate account at check time.'
      : 'Remove the field or check its spelling against registry/schema.json.';
  }
  if (issue.code === 'too_small' && field === 'sources') {
    return 'Add at least one source with kind, ref and retrieved (YYYY-MM-DD): every claim must be traceable.';
  }
  if (issue.code === 'invalid_type' && field === 'sources') {
    return 'Add a sources list with at least one item: kind, ref and retrieved (YYYY-MM-DD).';
  }
  if (issue.code === 'too_small' && (field === 'gates' || field === 'versions')) {
    return 'List at least one item, or remove the empty list.';
  }
  if (field === 'applies')
    return 'Add applies.gates (feature gate addresses) and/or applies.versions (semver ranges).';
  if (issue.code === 'invalid_type' && issue.expected === 'int')
    return 'Use a whole number; fractional numbers are not allowed in entries.';
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
      try {
        new RegExp(rule.pattern);
      } catch (error) {
        issues.push({
          path: `${at}.pattern`,
          message: `Pattern does not compile: ${(error as Error).message}`,
          hint: 'Fix the regular expression.',
        });
      }
    }
    if (rule.kind === 'lockfile-version' && semver.validRange(rule.package.range) === null) {
      issues.push({
        path: `${at}.package.range`,
        message: `"${rule.package.range}" is not a semver range`,
        hint: 'Use a range such as "<8.0.0" or ">=1.2.0 <2.0.0".',
      });
    }
  });

  entry.applies.gates?.forEach((gate, index) => {
    if (!isAddress(gate.address)) {
      issues.push({
        path: `applies.gates[${index}].address`,
        message: `"${gate.address}" is not a 32-byte base58 address`,
        hint: 'Copy the feature gate address from the client source code.',
      });
    }
  });
  entry.applies.versions?.forEach((item, index) => {
    if (semver.validRange(item.range) === null) {
      issues.push({
        path: `applies.versions[${index}].range`,
        message: `"${item.range}" is not a semver range`,
        hint: 'Use a range such as ">=4.2.0".',
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

/** Validates one parsed entry: shape first, then the checks a schema cannot express. */
export function validateEntry(raw: unknown): ValidationResult {
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
        hint: hintFor(issue),
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
          path: `${entry.id}.relations[${index}].id`,
          message: `No entry with id "${relation.id}"`,
          hint: 'Add the related entry to the registry or fix the id.',
        });
      }
    });
  }
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
