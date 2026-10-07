import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { renderSite, siteWatchOf, validatePath } from '../packages/core/dist/index.js';

const root = new URL('..', import.meta.url);
const watchFile = new URL('site/watch.json', root);
const flag = process.argv.indexOf('--watch-report');
if (flag !== -1) {
  const reportPath = process.argv[flag + 1];
  if (reportPath === undefined) {
    console.error('--watch-report takes the path of a report.json written by epochnotes watch solana');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  mkdirSync(new URL('site/', root), { recursive: true });
  writeFileSync(watchFile, `${JSON.stringify(siteWatchOf(report), null, 2)}\n`);
}
const registry = validatePath(new URL('registry/entries', root).pathname);
if (registry.files.some((file) => file.entry === undefined)) {
  console.error('The registry does not validate: run epochnotes registry validate registry/entries');
  process.exit(1);
}
const entries = registry.files.map((file) => file.entry);
const watch = existsSync(watchFile) ? JSON.parse(readFileSync(watchFile, 'utf8')) : undefined;
writeFileSync(new URL('index.html', root), renderSite(entries, watch));
console.log(
  `index.html: ${entries.length} entries${watch === undefined ? '' : `, watcher report of ${watch.agave.retrieved}`}`,
);
