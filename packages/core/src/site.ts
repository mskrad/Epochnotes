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
  return `<article class="card entry" id="${escapeHtml(entry.id)}">
<header>
<h3>${escapeHtml(subject.title ?? subject.name)}</h3>
<p class="meta"><span class="tag">${escapeHtml(subject.name)}</span>${chainsOf(activations)
    .map((chain) => `<span class="tag chain">${escapeHtml(chain)}</span>`)
    .join(
      '',
    )}<span class="muted">entry <code>${escapeHtml(entry.id)}</code> · rev ${escapeHtml(String(entry.rev))}${statics + probes === 0 ? '' : ` · ${statics} static rule(s), ${probes} RPC probe(s)`}</span></p>
</header>
<h4>What breaks</h4>
<ul>${entry.breaks.map((item) => `<li><span class="tag surface">${escapeHtml(item.surface)}</span> ${escapeHtml(item.summary)}</li>`).join('')}</ul>
<h4>How to fix it</h4>
<ul>${entry.fix.map((item) => `<li>${escapeHtml(item.summary)}</li>`).join('')}</ul>
<details>
<summary>Activations (${activations.length}) and sources (${entry.sources.length})</summary>
<ul class="small">${activations.map(activationLine).join('')}</ul>
<ul class="small">${entry.sources.map((source) => `<li><span class="tag">${escapeHtml(source.kind)}</span> ${link(source.ref, source.ref.replace(/^https:\/\//, ''))} <span class="muted">retrieved ${escapeHtml(source.retrieved)}</span></li>`).join('')}</ul>
</details>
</article>`;
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
  return `<p>Read on ${escapeHtml(watch.agave.retrieved)} from agave ${link(commit, watch.agave.commit.slice(0, 12))} and three clusters (${WATCHED_CLUSTERS.map((cluster) => `${cluster} slot ${escapeHtml(watch.clusters[cluster].slot)}`).join(', ')}): <strong>${escapeHtml(String(watch.declared))}</strong> feature gates declared, <strong>${escapeHtml(String(watch.inRegistry))}</strong> of them covered by the registry.</p>
<h3>On the way to mainnet-beta (${watch.upcoming.length})</h3>
<p class="muted">Not active on mainnet-beta yet, but active on testnet or devnet, or already scheduled on mainnet-beta.</p>
<div class="scroll"><table>
<thead><tr><th>Gate</th><th>SIMD</th>${WATCHED_CLUSTERS.map((cluster) => `<th>${cluster}</th>`).join('')}<th>Entry</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

/**
 * The project page as one self-contained HTML document: no script, no external resource, every value escaped.
 */
export function renderSite(entries: Entry[], watch?: SiteWatch): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const chains = [...new Set(sorted.flatMap((entry) => chainsOf(activationsOf(entry))))].sort(
    (a, b) => chainRank(a) - chainRank(b) || a.localeCompare(b),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Epochnotes</title>
<meta name="description" content="A signed registry of network changes on Solana, Ethereum and Base, and the checks built on it.">
<meta property="og:title" content="Epochnotes — read the layers of change">
<meta property="og:description" content="A field journal for network changes. Signed records, clear impact, and checks you can run.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://mskrad.github.io/Epochnotes/">
<meta property="og:image" content="https://mskrad.github.io/Epochnotes/assets/brand/social.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(MARK)}">
<style>
${STYLE}
</style>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<main id="content">
<header class="masthead">
<a class="brand" href="#content" aria-label="Epochnotes home">${MARK}<span>Epochnotes</span></a>
<nav aria-label="Main navigation"><a href="#registry">Registry</a><a href="#watcher">Watcher</a><a href="#get-started">Get started</a>${link(REPOSITORY, 'GitHub ↗')}</nav>
</header>
<section class="hero">
<div>
<p class="eyebrow">A field journal for network changes</p>
<h1>Read the layers<br>of change.</h1>
<p class="intro">A signed registry of network changes on ${chains.slice(0, -1).map(escapeHtml).join(', ')}${chains.length > 1 ? ' and ' : ''}${escapeHtml(chains.at(-1) ?? '')}. Understand what breaks in your code, where, and how to fix it.</p>
<div class="actions"><a class="button primary" href="#registry">Explore the registry</a><a class="button" href="#get-started">Run your first check</a></div>
</div>
<figure class="specimen">${MARK}<figcaption class="specimen-caption">Epochnotes / A record of changing epochs</figcaption></figure>
</section>
<div class="edition"><span>${sorted.length} entries · ${chains.map(escapeHtml).join(' / ')} · Signed log v1</span><span>Pre-release · Not audited · <a href="registry/versions/1.json">Read the signed manifest ↗</a></span></div>

<section>
<p class="section-label">01 / From source to understanding</p>
<h2>How it works</h2>
<div class="grid">
<div class="card"><h3>Signed entries</h3><p>Each change is an entry built from primary sources — a SIMD or an EIP, the client's code, the chain itself. A version of the registry is a Merkle root, signed by its publisher and anchored by a program on Solana devnet.</p></div>
<div class="card"><h3>Checks</h3><p><code>check repo</code> finds the code a change breaks; <code>check rpc</code> asks a provider, read-only, whether it behaves as the entry says; <code>status</code> reads the activation from each chain at the moment you ask.</p></div>
<div class="card"><h3>Watcher</h3><p>Every day it reads the feature gates agave declares and their state on three Solana clusters, and drafts an entry for what moved outside the registry. A person finishes the draft from the SIMD and signs it.</p></div>
</div>
</section>

<section id="watcher">
<p class="section-label">02 / The latest field reading</p>
<h2>What the Solana watcher sees</h2>
${watchSection(watch)}
</section>

<section id="registry">
<p class="section-label">03 / Layers in the record</p>
<h2>The registry (${sorted.length} entries)</h2>
${sorted.map(entryCard).join('\n')}
</section>

<section id="get-started">
<p class="section-label">04 / Put the record to work</p>
<h2>Check it yourself</h2>
<p>Install the CLI with <code>npm install -g @epochnotes/cli</code>, then read from the published signed log:</p>
<pre><code>export EPOCHNOTES_VERSIONS=https://mskrad.github.io/Epochnotes/registry/versions
curl -fsS https://mskrad.github.io/Epochnotes/registry/publishers.json -o epochnotes-publishers.json
export EPOCHNOTES_PUBLISHERS=./epochnotes-publishers.json</code></pre>
<pre><code>epochnotes registry read --json --status mainnet-beta   # verified entries and the state of each activation
epochnotes status --chain base                          # every activation the registry names on Base
epochnotes check repo &lt;path&gt;                            # where a change breaks this code
epochnotes check rpc --rpc-url &lt;endpoint&gt;               # does this provider behave as the entry says
epochnotes watch solana                                 # what moved on Solana since the last look</code></pre>
<p class="muted">When it cannot verify what it reads, it refuses to answer rather than guess.</p>
</section>

<section class="roadmap">
<p class="section-label">05 / What comes next</p>
<h2>Roadmap</h2>
<div class="grid">
<div class="card"><h3>Now</h3><ul>
<li>Entries for Solana, Ethereum and Base in one signed log, verified offline and against the program on devnet</li>
<li>Static rules for TypeScript, JavaScript, Rust, Go, Python, Solidity and lockfiles; read-only RPC probes</li>
<li>Rent held above the minimum: scan, close plan, withdraw template</li>
<li>A Claude skill that answers from the verified registry only</li>
<li>The Solana watcher, run daily by a scheduled Claude task that drafts from the SIMD</li>
</ul></div>
<div class="card"><h3>Next</h3><ul>
<li>Anchor the first signed version of the registry on Solana devnet</li>
<li>Watchers for Ethereum and Base: fork times in the client configurations</li>
<li>A notification when something outside the registry moves</li>
<li>This page updated from each watcher report</li>
<li>Entries for the gates already on the way to mainnet-beta</li>
</ul></div>
</div>
</section>

<footer>
<p>Generated by <code>npm run site</code> from <code>registry/entries</code>${watch === undefined ? '' : ` and the watcher report of ${escapeHtml(watch.agave.retrieved)}`}. ${link(REPOSITORY, 'mskrad/Epochnotes')}</p>
</footer>
</main>
</body>
</html>
`;
}
