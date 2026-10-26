import type { SiteFinding, SiteFindings } from './site.js';

/** A pull request on github.com, named by its repository and number. */
export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

/** Where a pull request stands, as the GitHub REST API reports it. */
export interface PullRequestState {
  state: 'open' | 'closed';
  mergedAt: string | null;
  closedAt: string | null;
}

/** What one refresh changed, one line per finding whose outcome moved. */
export interface FindingsRefresh {
  findings: SiteFindings;
  changes: string[];
}

/** The pull request a github.com URL points at, or undefined for an issue or any other page. */
export function pullRequestRef(url: string): PullRequestRef | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url);
  const [, owner, repo, number] = match ?? [];
  if (owner === undefined || repo === undefined || number === undefined) return undefined;
  return { owner, repo, number: Number(number) };
}

/** The findings whose outcome can still move: an open or closed pull request, not a merged one. */
export function watchedPullRequests(findings: SiteFindings): string[] {
  return findings.items
    .filter((item) => item.outcome !== 'merged' && pullRequestRef(item.outcomeUrl) !== undefined)
    .map((item) => item.outcomeUrl);
}

function outcomeOf(item: SiteFinding, pull: PullRequestState): SiteFinding {
  if (pull.mergedAt !== null) return { ...item, outcome: 'merged', date: pull.mergedAt.slice(0, 10) };
  if (pull.state === 'closed')
    return { ...item, outcome: 'closed', date: (pull.closedAt ?? item.date).slice(0, 10) };
  if (item.outcome === 'closed') return { ...item, outcome: 'open' };
  return item;
}

/**
 * Applies the pull request states to the findings. Merged findings move to the front, keeping their order,
 * because the page shows the first three. `checked` becomes `today` when an outcome moved or when the last
 * check is a week old or more, so a quiet week still shows that the outcomes were looked at.
 */
export function refreshFindings(
  findings: SiteFindings,
  pulls: ReadonlyMap<string, PullRequestState>,
  today: string,
): FindingsRefresh {
  const changes: string[] = [];
  const items = findings.items.map((item) => {
    const pull = pulls.get(item.outcomeUrl);
    if (pull === undefined || item.outcome === 'merged') return item;
    const next = outcomeOf(item, pull);
    if (next.outcome !== item.outcome)
      changes.push(`${item.project}: ${item.outcomeText} ${item.outcome} -> ${next.outcome}`);
    return next;
  });
  const ordered = [
    ...items.filter((item) => item.outcome === 'merged'),
    ...items.filter((item) => item.outcome !== 'merged'),
  ];
  const stale =
    Date.parse(`${today}T00:00:00Z`) - Date.parse(`${findings.checked}T00:00:00Z`) >= 7 * 86_400_000;
  return {
    findings: { checked: changes.length > 0 || stale ? today : findings.checked, items: ordered },
    changes,
  };
}

const NUMBER_WORDS = [
  'None',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
  'Twenty',
];

function countWord(count: number, capitalized: boolean): string {
  const word = NUMBER_WORDS[count] ?? String(count);
  return capitalized ? word : word.toLowerCase();
}

function readmeOutcome(item: SiteFinding): string {
  if (item.outcome === 'merged') return `merged: [${item.outcomeText}](${item.outcomeUrl}), ${item.date}`;
  if (item.outcome === 'closed') return `closed: [${item.outcomeText}](${item.outcomeUrl}), ${item.date}`;
  return 'open';
}

/**
 * The README with its "Found in the field" summary sentence and the Outcome column brought in line with the
 * findings. The hand-written "What broke" wording stays; rows follow the findings order, and a finding without
 * a README row is an error, because the README must not silently show fewer reports than the page.
 */
export function readmeWithFindings(readme: string, findings: SiteFindings): string {
  const merged = findings.items.filter((item) => item.outcome === 'merged').length;
  const summary =
    /[A-Z][a-z]+ (?:is|are) reported; \w+ (?:is|are) already fixed and merged\. Outcomes as of \d{4}-\d{2}-\d{2};/;
  if (!summary.test(readme))
    throw new Error('the README has no "... are reported; ... Outcomes as of" sentence');
  const sentence = `${countWord(findings.items.length, true)} ${findings.items.length === 1 ? 'is' : 'are'} reported; ${countWord(merged, false)} ${merged === 1 ? 'is' : 'are'} already fixed and merged. Outcomes as of ${findings.checked};`;
  const lines = readme.replace(summary, sentence).split('\n');
  const rowIndexes: number[] = [];
  const rows = new Map<string, string>();
  lines.forEach((line, index) => {
    const project = /^\| \[([^\]]+)\]\(https:\/\/github\.com\//.exec(line)?.[1];
    if (project === undefined) return;
    rowIndexes.push(index);
    rows.set(project, line);
  });
  const updated = findings.items.map((item) => {
    const row = rows.get(item.project);
    if (row === undefined) throw new Error(`the README has no row for ${item.project}`);
    const cells = row.split('|');
    cells[cells.length - 2] = ` ${readmeOutcome(item)} `;
    return cells.join('|');
  });
  if (rowIndexes.length !== updated.length)
    throw new Error(`the README has ${rowIndexes.length} finding rows, the findings file ${updated.length}`);
  return lines.map((line, index) => updated[rowIndexes.indexOf(index)] ?? line).join('\n');
}

/** Reads one pull request from the GitHub REST API; a token raises the rate limit from 60 to 5,000 an hour. */
export async function fetchPullRequestState(
  ref: PullRequestRef,
  options: { token?: string; fetch?: typeof fetch } = {},
): Promise<PullRequestState> {
  const response = await (options.fetch ?? fetch)(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok)
    throw new Error(`GitHub answered ${response.status} for ${ref.owner}/${ref.repo}#${ref.number}`);
  const body = (await response.json()) as { state?: unknown; merged_at?: unknown; closed_at?: unknown };
  if (body.state !== 'open' && body.state !== 'closed')
    throw new Error(`GitHub returned no state for ${ref.owner}/${ref.repo}#${ref.number}`);
  return {
    state: body.state,
    mergedAt: typeof body.merged_at === 'string' ? body.merged_at : null,
    closedAt: typeof body.closed_at === 'string' ? body.closed_at : null,
  };
}
