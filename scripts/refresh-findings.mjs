import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  fetchPullRequestState,
  pullRequestRef,
  readmeWithFindings,
  refreshFindings,
  siteFindingsOf,
  watchedPullRequests,
} from '../packages/core/dist/index.js';

const root = new URL('..', import.meta.url);
const findingsFile = new URL('site/findings.json', root);
const readmeFile = new URL('README.md', root);
const dryRun = process.argv.includes('--dry-run');
const today = new Date().toISOString().slice(0, 10);

const findings = siteFindingsOf(JSON.parse(readFileSync(findingsFile, 'utf8')));
const pulls = new Map();
for (const url of watchedPullRequests(findings)) {
  pulls.set(
    url,
    await fetchPullRequestState(pullRequestRef(url), { token: process.env.GITHUB_TOKEN || undefined }),
  );
}
const { findings: refreshed, changes } = refreshFindings(findings, pulls, today);

for (const [url, pull] of pulls)
  console.log(`${url}: ${pull.mergedAt === null ? pull.state : `merged ${pull.mergedAt}`}`);
for (const change of changes) console.log(`changed: ${change}`);

if (refreshed.checked === findings.checked && changes.length === 0) {
  console.log(`no change; outcomes stay as of ${findings.checked}`);
  process.exit(0);
}
if (dryRun) {
  console.log(`--dry-run: would write outcomes as of ${refreshed.checked}`);
  process.exit(0);
}
writeFileSync(findingsFile, `${JSON.stringify(refreshed, null, 2)}\n`);
writeFileSync(readmeFile, readmeWithFindings(readFileSync(readmeFile, 'utf8'), refreshed));
execFileSync('npx', ['prettier', '--write', 'README.md', 'site/findings.json'], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync('node', ['scripts/write-site.mjs'], { cwd: root, stdio: 'inherit' });
console.log(`wrote site/findings.json, README.md and index.html with outcomes as of ${refreshed.checked}`);
