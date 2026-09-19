import { redactUrl } from '@epochnotes/core';

import { EXIT } from './cluster.js';

export interface Problem {
  path: string;
  message: string;
  hint: string;
}

/**
 * With `--json` every outcome is one JSON document on stdout — success, findings and failures alike — so a
 * caller never has to parse prose. Without it, results go to stdout and problems to stderr.
 */
export function reportIssues(json: boolean | undefined, issues: Problem[]): void {
  if (json) console.log(JSON.stringify({ ok: false, issues }, null, 2));
  else
    for (const issue of issues)
      console.error(`FAIL  ${issue.path}: ${issue.message}\n        fix: ${issue.hint}`);
  process.exitCode = EXIT.findings;
}

/** An environment failure: unreadable path, unreachable cluster, refused transaction. Exit code 2. */
export function reportError(json: boolean | undefined, what: string, error: unknown): void {
  // A failed transaction hides its reason in the cause chain ("Custom program error: #6000"): keep all of it.
  const reasons: string[] = [];
  for (let at: unknown = error; at instanceof Error && reasons.length < 5; at = at.cause)
    reasons.push(at.message);
  if (reasons.length === 0) reasons.push(String(error));
  // Transport errors quote the endpoint, and provider API keys travel in its path or query.
  const text = reasons.join(' <- ').replace(/https?:\/\/[^\s'"]+/g, (url) => redactUrl(url));
  if (json) console.log(JSON.stringify({ ok: false, error: `Cannot ${what}: ${text}` }, null, 2));
  else console.error(`Cannot ${what}: ${text}`);
  process.exitCode = EXIT.environment;
}
