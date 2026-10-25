import { chainNameOf } from './chains.js';
import { activationsOf, type Activation, type Entry, subjectOf } from './schema.js';
import { MARK } from './site-brand.js';
import { STYLE } from './site-style.js';
import { WATCHED_CLUSTERS, type WatchedCluster, type WatchReport } from './watch.js';

/** The part of a watcher report the project page shows. */
export interface SiteWatch {
  agave: { repository: string; commit: string; retrieved: string };
  clusters: Record<WatchedCluster, { slot: string }>;
  declared: number;
  inRegistry: number;
  upcoming: {
    module: string;
    simd?: string;
    description?: string;
    state: Record<WatchedCluster, string>;
    entry?: string;
  }[];
}

/**
 * Keeps of a watcher report only what the page shows; throws when the report lacks its counts or its list.
 */
export function siteWatchOf(report: WatchReport): SiteWatch {
  if (
    !Number.isInteger(report.declared) ||
    !Number.isInteger(report.inRegistry) ||
    !Array.isArray(report.upcoming)
  )
    throw new Error('it has no counts of declared and covered gates, or no list of upcoming gates');
  return {
    agave: report.agave,
    clusters: report.clusters,
    declared: report.declared,
    inRegistry: report.inRegistry,
    upcoming: report.upcoming.map((feature) => ({
      module: feature.module,
      ...(feature.simd === undefined ? {} : { simd: feature.simd }),
      ...(feature.description === undefined ? {} : { description: feature.description }),
      state: feature.state,
      ...(feature.entry === undefined ? {} : { entry: feature.entry }),
    })),
  };
}

/** A breakage found in someone else's repository, what was sent to its maintainers, and where it stands. */
export interface SiteFinding {
  project: string;
  repository: string;
  broke: string;
  reported: { text: string; url: string }[];
  outcome: 'merged' | 'open';
  outcomeText: string;
  outcomeUrl: string;
  date: string;
}

/** The findings shown on the page, with the date their outcomes were last checked. */
export interface SiteFindings {
  checked: string;
  items: SiteFinding[];
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isHttps = (value: unknown): value is string => isText(value) && /^https:\/\/[^\s"'<>]+$/.test(value);
const isDate = (value: unknown): value is string => isText(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Reads the findings file of the page; throws on the first item it cannot show as written, because a
 * claim about someone else's project must not be shown half-filled or with a link that is not https.
 */
export function siteFindingsOf(data: unknown): SiteFindings {
  const file = data as { checked?: unknown; items?: unknown };
  if (typeof data !== 'object' || data === null || !isDate(file.checked) || !Array.isArray(file.items))
    throw new Error('it needs "checked" as YYYY-MM-DD and an "items" list');
  const items = file.items.map((value: unknown, index): SiteFinding => {
    const item = value as Record<string, unknown>;
    const reported = item.reported as { text?: unknown; url?: unknown }[] | undefined;
    if (
      typeof value !== 'object' ||
      value === null ||
      !isText(item.project) ||
      !isHttps(item.repository) ||
      !isText(item.broke) ||
      !Array.isArray(reported) ||
      reported.length === 0 ||
      !reported.every((report) => isText(report?.text) && isHttps(report?.url)) ||
      (item.outcome !== 'merged' && item.outcome !== 'open') ||
      !isText(item.outcomeText) ||
      !isHttps(item.outcomeUrl) ||
      !isDate(item.date)
    )
      throw new Error(`item ${index} is incomplete or has a link that is not https`);
    return {
      project: item.project,
      repository: item.repository,
      broke: item.broke,
      reported: reported.map((report) => ({ text: report.text as string, url: report.url as string })),
      outcome: item.outcome,
      outcomeText: item.outcomeText,
      outcomeUrl: item.outcomeUrl,
      date: item.date,
    };
  });
  return { checked: file.checked, items };
}

const REPOSITORY = 'https://github.com/mskrad/Epochnotes';
const SIMD_REPOSITORY = 'https://github.com/solana-foundation/solana-improvement-documents';

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function link(href: string, text: string): string {
  if (!/^https:\/\/[^\s"'<>]+$/.test(href)) return escapeHtml(text);
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

const CHAIN_ORDER = ['Solana', 'Ethereum', 'Base'];
const chainRank = (chain: string) =>
  CHAIN_ORDER.includes(chain) ? CHAIN_ORDER.indexOf(chain) : CHAIN_ORDER.length;

const CHEVRON =
  '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
const EXTERNAL =
  '<svg class="external" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6m0-6L10 14m0-10H4v16h16v-6"/></svg>';

const PREVIEW_NAMES: Record<string, string> = {
  'tx-v1': 'Transaction v1',
  'eip-7702': 'EIP-7702',
  'rent-simd-0437': 'Rent reduction',
  'slot-duration': 'Slot duration',
  alpenglow: 'Alpenglow',
};

function changeExplorer(entries: Entry[]): string {
  const ordered = [...entries].sort((a, b) => {
    const ids = Object.keys(PREVIEW_NAMES);
    const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
    return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
  });
  if (ordered.length === 0) return '';
  return `<div class="explorer" data-ui>
<fieldset class="change-nav"><legend>Network changes</legend>${ordered
    .map(
      (entry, index) =>
        `<label><input type="radio" name="network-change" id="change-${index}" value="${index}"${index === 0 ? ' checked' : ''}><span>${escapeHtml(PREVIEW_NAMES[entry.id] ?? subjectOf(entry).title ?? subjectOf(entry).name)}</span></label>`,
    )
    .join('')}</fieldset>
<div class="change-panels">${ordered
    .map((entry, index) => {
      const subject = subjectOf(entry);
      const name = PREVIEW_NAMES[entry.id] ?? subject.title ?? subject.name;
      const tx = entry.id === 'tx-v1';
      const source = entry.sources.find((item) => item.ref.startsWith('https://'));
      return `<article class="change-panel panel-${index}" aria-label="${escapeHtml(name)} example">
<header><h2>${escapeHtml(name)}</h2><p>${chainsOf(activationsOf(entry)).map(escapeHtml).join(' · ')}</p></header>
<div class="source-flow">
<div class="flow-cell"><p>Primary source</p><h3>${escapeHtml(subject.name)}</h3><p>${escapeHtml(tx ? 'Transaction v1 specification' : (subject.title ?? subject.name))}</p>${source === undefined ? '' : link(source.ref, 'View source').replace('</a>', ` ${EXTERNAL}</a>`)}</div>
${CHEVRON}
<div class="flow-cell"><p>Signed record</p><h3>${escapeHtml(name)}</h3><p>${chainsOf(activationsOf(entry)).map(escapeHtml).join(' · ')} · rev ${escapeHtml(String(entry.rev))}</p><a href="#${escapeHtml(entry.id)}">View record ${EXTERNAL}</a></div>
${CHEVRON}
<div class="flow-cell impact"><p>Impact on your code</p><p class="impact-statement">${escapeHtml(tx ? 'RPC reads limited to version 0 can fail' : (entry.breaks[0]?.summary ?? 'Read the entry for affected code'))}</p></div>
</div>
${tx ? '<div class="example-check"><p>Example check</p><pre><code><span class="before">−  maxSupportedTransactionVersion: 0</span>\n<span class="after">+  maxSupportedTransactionVersion: 1</span></code></pre></div>' : `<div class="example-check"><p>From the entry</p><p>${escapeHtml(entry.fix[0]?.summary ?? 'Read the entry for client-specific instructions.')}</p></div>`}
<a class="client-link" href="#${escapeHtml(entry.id)}">Client-specific instructions in the record ${CHEVRON}</a>
</article>`;
    })
    .join('')}</div>
</div>`;
}

function chainsOf(activations: Activation[]): string[] {
  const names = activations.map((activation) =>
    activation.kind === 'feature-account' ? 'Solana' : (chainNameOf(activation.chain) ?? activation.chain),
  );
  return [...new Set(names.map((name) => name.charAt(0).toUpperCase() + name.slice(1)))];
}

function activationLine(activation: Activation): string {
  const where =
    activation.kind === 'feature-account'
      ? `feature gate <code>${escapeHtml(activation.address)}</code>`
      : activation.kind === 'timestamp'
        ? `${escapeHtml(chainNameOf(activation.chain) ?? activation.chain)} at ${new Date(activation.at * 1000).toISOString().replace('.000Z', 'Z')}`
        : `${escapeHtml(activation.chain)} at block ${activation.at}`;
  return `<li><span class="label">${escapeHtml(activation.label)}</span> — ${where}${activation.effect === undefined ? '' : `<br><span class="muted">${escapeHtml(activation.effect)}</span>`}</li>`;
}

function entryCard(entry: Entry): string {
  const subject = subjectOf(entry);
  const activations = activationsOf(entry);
  const checks = entry.detect.map((rule) => rule.kind);
  const statics = checks.filter((kind) => kind !== 'runtime-probe').length;
  const probes = checks.filter((kind) => kind === 'runtime-probe').length;
  return `<details class="entry"><summary>
<h3>${escapeHtml(PREVIEW_NAMES[entry.id] ?? subject.title ?? subject.name)}</h3>
<p class="meta"><span class="tag">${escapeHtml(subject.name)}</span>${chainsOf(activations)
    .map((chain) => `<span class="tag chain">${escapeHtml(chain)}</span>`)
    .join(
      '',
    )}<span class="muted">entry <code>${escapeHtml(entry.id)}</code> · rev ${escapeHtml(String(entry.rev))}${statics + probes === 0 ? '' : ` · ${statics} static rule(s), ${probes} RPC probe(s)`}</span></p></summary>
<article id="${escapeHtml(entry.id)}">
<p class="entry-canonical">${escapeHtml(subject.title ?? subject.name)}</p>
<h4>What breaks</h4>
<ul>${entry.breaks.map((item) => `<li><span class="tag surface">${escapeHtml(item.surface)}</span> ${escapeHtml(item.summary)}</li>`).join('')}</ul>
<h4>How to fix it</h4>
<ul>${entry.fix.map((item) => `<li>${escapeHtml(item.summary)}</li>`).join('')}</ul>
<details>
<summary>Activations (${activations.length}) and sources (${entry.sources.length})</summary>
<ul class="small">${activations.map(activationLine).join('')}</ul>
<ul class="small">${entry.sources.map((source) => `<li><span class="tag">${escapeHtml(source.kind)}</span> ${link(source.ref, source.ref.replace(/^https:\/\//, ''))} <span class="muted">retrieved ${escapeHtml(source.retrieved)}</span></li>`).join('')}</ul>
</details>
</article>
</details>`;
}

function stateChip(state: string): string {
  return `<span class="state ${escapeHtml(state)}">${escapeHtml(state)}</span>`;
}

function watchSection(watch: SiteWatch | undefined): string {
  if (watch === undefined)
    return '<p class="muted">No watcher report yet: run <code>epochnotes watch solana</code> and <code>npm run site -- --watch-report &lt;report.json&gt;</code>.</p>';
  const commit = `${watch.agave.repository}/tree/${watch.agave.commit}`;
  const rows = watch.upcoming
    .map(
      (item) => `<tr>
<td><code>${escapeHtml(item.module)}</code>${item.description === undefined ? '' : `<br><span class="muted">${escapeHtml(item.description)}</span>`}</td>
<td>${item.simd === undefined ? '—' : link(`${SIMD_REPOSITORY}/tree/main/proposals`, item.simd)}</td>
${WATCHED_CLUSTERS.map((cluster) => `<td>${stateChip(item.state[cluster] ?? 'unknown')}</td>`).join('')}
<td>${item.entry === undefined ? '<span class="state uncovered">not yet</span>' : `<a href="#${escapeHtml(item.entry)}"><code>${escapeHtml(item.entry)}</code></a>`}</td>
</tr>`,
    )
    .join('\n');
  return `<p>Snapshot read on ${escapeHtml(watch.agave.retrieved)} from agave ${link(commit, watch.agave.commit.slice(0, 12))} and three clusters (${WATCHED_CLUSTERS.map((cluster) => `${cluster} slot ${escapeHtml(watch.clusters[cluster].slot)}`).join(', ')}): <strong>${escapeHtml(String(watch.declared))}</strong> feature gates declared, <strong>${escapeHtml(String(watch.inRegistry))}</strong> of them covered by the registry.</p>
<h3>Upcoming gates (${watch.upcoming.length})</h3>
<p class="muted">At this reading: not active on mainnet-beta, but active on testnet or devnet, or already scheduled on mainnet-beta. States can have changed since this snapshot.</p>
<p class="scroll-hint">Scroll the table horizontally to compare all three clusters.</p>
<div class="scroll" tabindex="0" role="region" aria-label="Solana watcher snapshot"><table>
<thead><tr><th>Gate</th><th>SIMD</th>${WATCHED_CLUSTERS.map((cluster) => `<th>${cluster}</th>`).join('')}<th>Entry</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

function findingRow(item: SiteFinding): string {
  const summaries: Record<string, string> = {
    'solana-foundation/solana-com': 'Slot-time page RPC reads',
    'helius-labs/core-ai': 'MCP server and CLI full-block reads',
    'OpenZeppelin/openzeppelin-monitor': 'Solana monitor full-block reads',
  };
  const merged = item.outcome === 'merged';
  return `<article class="finding">
<details><summary><span class="outcome-icon ${merged ? 'merged' : 'open'}" aria-hidden="true">${merged ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 12 4 4 8-8"/></svg>' : ''}</span><span class="finding-project">${escapeHtml(item.project)}<span class="outcome-text">${escapeHtml(item.outcomeText)} ${merged ? 'merged' : 'open'}</span></span><span class="finding-summary">${escapeHtml(summaries[item.project] ?? item.broke)}</span><span class="sr-only"> — details and report</span></summary>
<div class="finding-body"><p>${escapeHtml(item.broke)}</p><p>${link(item.repository, item.project)} · ${item.reported.map((report) => link(report.url, report.text)).join(', ')} · ${escapeHtml(item.date)}</p></div></details>
<a class="finding-pr" href="${/^https:\/\/[^\s"'<>]+$/.test(item.outcomeUrl) ? escapeHtml(item.outcomeUrl) : '#findings'}">View PR ${EXTERNAL}<span class="sr-only"> for ${escapeHtml(item.project)}</span></a>
</article>`;
}

function findingsSection(findings: SiteFindings): string {
  const merged = findings.items.filter((item) => item.outcome === 'merged').length;
  const date = new Date(`${findings.checked}T00:00:00Z`);
  const checked =
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === findings.checked
      ? date.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : findings.checked;
  return `<section class="findings wrap" id="findings">
<div class="findings-heading"><div><h2>Found in the field</h2><p>Findings and fixes in public repositories.</p></div><div class="findings-proof"><p>59 public repositories checked. ${findings.items.length} report${findings.items.length === 1 ? '' : 's'}. ${merged} fix${merged === 1 ? '' : 'es'} merged.</p><p class="muted">Outcomes checked ${escapeHtml(checked)}.</p></div></div>
${findings.items.slice(0, 3).map(findingRow).join('')}
${findings.items.length <= 3 ? '' : `<details class="more-findings"><summary>All ${findings.items.length} reports ${CHEVRON}</summary>${findings.items.slice(3).map(findingRow).join('')}</details>`}
<p class="findings-method">We ran <code>epochnotes check repo</code> over 59 public Solana repositories, checked every hit by hand and reproduced each breakage on mainnet before reporting it. Outcomes as of ${escapeHtml(findings.checked)}. An open pull request is a proposal, not an acceptance.</p>
</section>`;
}

/**
 * The project page as static HTML with a local font and brand mark: no script or remote resource, every value escaped.
 */
export function renderSite(entries: Entry[], watch?: SiteWatch, findings?: SiteFindings): string {
  const shown = findings !== undefined && findings.items.length > 0 ? findings : undefined;
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const chains = [...new Set(sorted.flatMap((entry) => chainsOf(activationsOf(entry))))].sort(
    (a, b) => chainRank(a) - chainRank(b) || a.localeCompare(b),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preload" href="assets/fonts/work-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<title>Epochnotes</title>
<meta name="description" content="A signed registry of network changes on Solana, Ethereum and Base, and the checks built on it.">
<meta property="og:title" content="Epochnotes — keep up with network changes">
<meta property="og:description" content="Know what breaks in your code, with fixes tied to signed records and primary sources.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://mskrad.github.io/Epochnotes/">
<meta property="og:image" content="https://mskrad.github.io/Epochnotes/assets/brand/social.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(MARK)}">
<style>
${STYLE}
${sorted.map((_, index) => `.explorer:has(#change-${index}:checked) .panel-${index}{display:block}`).join('\n')}
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="masthead wrap">
<a class="brand" href="#content" aria-label="Epochnotes home"><img src="assets/brand/mark.svg" width="60" height="54" alt=""><span>Epochnotes</span></a>
<nav aria-label="Main navigation"><a href="#how-it-works">How it works</a>${shown === undefined ? '' : '<a href="#findings">Findings</a>'}<a href="#registry">Registry</a>${link(REPOSITORY, 'GitHub')}<a class="button primary" href="#agents">Install the skill ${CHEVRON}</a></nav>
</header>
<main id="content">
<section class="hero">
<div class="wrap">
<h1><span>Keep up with</span><span>network changes.</span></h1>
<p class="intro">Know what breaks in your code, with fixes tied to<br class="desktop-break"> signed records and primary sources.</p>
<div class="actions"><a class="button primary" href="#agents">Install the skill ${CHEVRON}</a></div>
<p class="license">Free, open source, MIT.</p>
${changeExplorer(sorted)}
</div>
</section>
${shown === undefined ? '' : findingsSection(shown)}
<div class="page-content wrap">
<div class="edition"><span>${sorted.length} entries · ${chains.map(escapeHtml).join(' / ')} · Signed log v1</span><span>Pre-release · Not audited · <a href="registry/versions/1.json">Read the signed manifest ${EXTERNAL}</a></span></div>

<section id="how-it-works">
<h2>How it works</h2>
<div class="grid">
<div class="card"><h3>Signed entries</h3><p>Each change is an entry built from primary sources — a SIMD or an EIP, the client's code, the chain itself. A version of the registry is a Merkle root, signed by its publisher and anchored by a program on Solana devnet.</p></div>
<div class="card"><h3>Checks</h3><p><code>check repo</code> finds the code a change breaks; <code>check rpc</code> asks a provider, read-only, whether it behaves as the entry says; <code>registry read --status</code> reads the activation from each chain at the moment you ask.</p></div>
<div class="card"><h3>Watcher</h3><p>Every day it reads the feature gates agave declares and their state on three Solana clusters, and drafts an entry for what moved outside the registry. A person finishes the draft from the SIMD and signs it.</p></div>
</div>
</section>

<section id="agents">
<h2>Ask your agent</h2>
<p>The Epochnotes skill lets you ask in plain words: is this upgrade live, and does my project break? Your agent answers from the signed registry, not from what it remembers, and checks your code with the same tool. It works with any agent that can run a command in your terminal: Claude Code, Codex and others.</p>
<div class="agent-capabilities">
<div><h3>Verified answers</h3><p>Every answer names the registry version, its signature and the slot or block it read the status from. If the registry cannot be verified, it does not answer at all.</p></div>
<div><h3>Project checks</h3><p>Code, contracts, lockfiles and your RPC provider: it runs the same checks as the command line and points at the line to fix.</p></div>
<div><h3>Explicit limits</h3><p>A rule that could not run, a file it did not read, a guess of its own: each is named, so silence never reads as a clean result.</p></div>
</div>
<div class="installation">
<h3>Install in a minute</h3>
<p>Get the skill once:</p>
<pre><code>git clone --depth 1 https://github.com/mskrad/Epochnotes ~/epochnotes-src</code></pre>
<p>Then add it to your agent. The skill is one folder with a <code>SKILL.md</code> file, the common format for agent skills.</p>
<div class="agent-installers">
<details open><summary>Claude Code</summary><p>In your terminal, or the Code tab of Claude Desktop:</p><pre><code>mkdir -p ~/.claude/skills &amp;&amp; cp -R ~/epochnotes-src/skills/epochnotes ~/.claude/skills/</code></pre></details>
<details><summary>Codex</summary><pre><code>mkdir -p ~/.codex/skills &amp;&amp; cp -R ~/epochnotes-src/skills/epochnotes ~/.codex/skills/</code></pre></details>
<details><summary>Other agents</summary><p>Add this line to the project's <code>AGENTS.md</code>, or its own instructions file:</p><pre><code>For questions about network upgrades on Solana, Ethereum or Base, follow ~/epochnotes-src/skills/epochnotes/SKILL.md.</code></pre></details>
</div>
<details class="trust-setup"><summary>Choose the published log</summary>
<p>Optional: point it at the published log before you start the agent. Without this the skill names the published log and asks you first, because the publishers file is your trust anchor.</p>
<pre><code>export EPOCHNOTES_VERSIONS=https://mskrad.github.io/Epochnotes/registry/versions
curl -fsS https://mskrad.github.io/Epochnotes/registry/publishers.json -o ~/.epochnotes-publishers.json
export EPOCHNOTES_PUBLISHERS=~/.epochnotes-publishers.json</code></pre>
</details>
</div>
<h3>Then ask</h3>
<ul class="example-questions"><li>Is transaction v1 live on Solana mainnet, and does this project break?</li><li>What does EIP-7702 change for my contracts on Base?</li><li>Check this project against recent network changes.</li></ul>
<p class="muted">In Claude Code you can also call the skill by name: <code>/epochnotes</code> followed by the question.</p>
<div class="agent-answer"><h3>A real answer</h3>
<p class="muted">From a run on Oct 12, 2026, in Claude Code on a small demo app; shortened.</p>
<pre><code>Yes, transaction v1 is live on Solana mainnet, and my-app breaks.
my-app/src/history.ts:6 calls getTransaction with maxSupportedTransactionVersion: 0.
Fix (from the entry): pass 1; with @solana/web3.js use 1.99.0 or later.

Status:   active on mainnet-beta since slot 447120000, read at slot 456149984 (feature account)
Registry: version 1, root 77216c0c..., signature verified, on-chain anchor matches
Not checked: the web3.js version (my-app has no lockfile); the runtime probe</code></pre>
</div>
<p>Prefer the terminal? <a href="#get-started">Use the CLI</a>.</p>
</section>

<section id="watcher">
<h2>Solana watcher</h2>
${watchSection(watch)}
</section>

<section id="registry">
<h2>The registry (${sorted.length} entries)</h2>
<div class="registry-entries" data-ui>${sorted.map(entryCard).join('\n')}</div>
</section>

<section id="get-started">
<h2>Check it yourself</h2>
<p>Install the CLI with <code>npm install -g @epochnotes/cli</code>, then read from the published signed log:</p>
<pre><code>export EPOCHNOTES_VERSIONS=https://mskrad.github.io/Epochnotes/registry/versions
curl -fsS https://mskrad.github.io/Epochnotes/registry/publishers.json -o epochnotes-publishers.json
export EPOCHNOTES_PUBLISHERS=./epochnotes-publishers.json</code></pre>
<pre><code>epochnotes registry read --json --status mainnet-beta   # verified entries and the state of each activation
epochnotes registry read --status base                  # the same entries, read on Base
epochnotes check repo &lt;path&gt;                            # where a change breaks this code
epochnotes check rpc --rpc-url &lt;endpoint&gt;               # does this provider behave as the entry says</code></pre>
<p class="muted">When it cannot verify what it reads, it refuses to answer rather than guess.</p>
</section>

<section class="roadmap">
<h2>Roadmap</h2>
<div class="grid">
<div class="card"><h3>Now</h3><ul>
<li>Entries for Solana, Ethereum and Base in one signed log, anchored and verified against the program on Solana devnet</li>
<li>Free and open source (MIT): a public good for developers</li>
<li>Static rules for TypeScript, JavaScript, Rust, Go, Python, Solidity and lockfiles; read-only RPC probes</li>
<li>Rent held above the minimum: scan, close plan, withdraw template</li>
<li>An agent skill for Claude Code, Codex and others that answers from the verified registry only</li>
<li>The Solana watcher, run daily by a scheduled Claude task that drafts from the SIMD</li>
</ul></div>
<div class="card"><h3>Next</h3><ul>
<li><code>status</code> and <code>watch</code> read the signed log, not only a clone of the repository</li>
<li>Watchers for Ethereum and Base: fork times in the client configurations</li>
<li>A notification when something outside the registry moves</li>
<li>This page updated from each watcher report</li>
<li>Entries for the gates already on the way to mainnet-beta</li>
</ul></div>
</div>
</section>

<footer>
<a class="footer-brand" href="#content">Epochnotes ${CHEVRON}</a>
<p>Generated by <code>npm run site</code> from <code>registry/entries</code>${watch === undefined ? '' : ` and the watcher report of ${escapeHtml(watch.agave.retrieved)}`}${shown === undefined ? '' : `, findings checked ${escapeHtml(shown.checked)}`}. ${link(REPOSITORY, 'mskrad/Epochnotes')}</p>
</footer>
</div>
</main>
</body>
</html>
`;
}
