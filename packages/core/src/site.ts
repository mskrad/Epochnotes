import { chainNameOf } from './chains.js';
import { activationsOf, type Activation, type Entry, subjectOf } from './schema.js';
import { WATCHED_CLUSTERS, type WatchedCluster, type WatchReport } from './watch.js';

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

export function siteWatchOf(report: WatchReport): SiteWatch {
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
    )}<span class="muted">entry <code>${escapeHtml(entry.id)}</code> · rev ${entry.rev}${statics + probes === 0 ? '' : ` · ${statics} static rule(s), ${probes} RPC probe(s)`}</span></p>
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
  return `<p>Read on ${escapeHtml(watch.agave.retrieved)} from agave ${link(commit, watch.agave.commit.slice(0, 12))} and three clusters (${WATCHED_CLUSTERS.map((cluster) => `${cluster} slot ${escapeHtml(watch.clusters[cluster].slot)}`).join(', ')}): <strong>${watch.declared}</strong> feature gates declared, <strong>${watch.inRegistry}</strong> of them covered by the registry.</p>
<h3>On the way to mainnet-beta (${watch.upcoming.length})</h3>
<p class="muted">Not active on mainnet-beta yet, but active on testnet or devnet, or already scheduled on mainnet-beta.</p>
<div class="scroll"><table>
<thead><tr><th>Gate</th><th>SIMD</th>${WATCHED_CLUSTERS.map((cluster) => `<th>${cluster}</th>`).join('')}<th>Entry</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

const STYLE = `:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a64;--card:#ffffff;--line:#e4e1d8;--accent:#5b3fd6;--tag:#efecf9;--ok:#1f7a4d;--ok-bg:#e3f4ea;--warn:#8a5a00;--warn-bg:#fbf0d9;--off:#5f5f5f;--off-bg:#eeeeec;--bad:#a8324a;--bad-bg:#f8e3e7;--code:#f3f1ec}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ebeae6;--muted:#a3a29b;--card:#1b1b1f;--line:#2e2e34;--accent:#a996ff;--tag:#26223a;--ok:#7fd6a5;--ok-bg:#163326;--warn:#f0c46a;--warn-bg:#3a2e12;--off:#b5b5b0;--off-bg:#2a2a2e;--bad:#f39aac;--bad-bg:#3d1c24;--code:#232328}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:0 16px 64px}
a{color:var(--accent);overflow-wrap:anywhere}
code{font:0.88em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre code{background:none;padding:0}
.hero{padding:56px 0 24px}
.hero h1{font-size:2.4rem;margin:0 0 8px;letter-spacing:-0.02em}
.hero p{font-size:1.15rem;max-width:44em;margin:0 0 12px}
h2{font-size:1.5rem;margin:48px 0 12px;letter-spacing:-0.01em}
h3{margin:0 0 6px;font-size:1.15rem}
h4{margin:14px 0 4px;font-size:0.95rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em}
.muted{color:var(--muted)}
.small{font-size:0.9rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.entry{margin-bottom:14px}
.entry ul{margin:4px 0;padding-left:20px}
.meta{margin:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tag{display:inline-block;background:var(--tag);border-radius:999px;padding:0 9px;font-size:0.8rem;line-height:1.6}
.label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85em}
details{margin-top:10px}
summary{cursor:pointer;color:var(--accent)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:0.9rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
.state{display:inline-block;border-radius:6px;padding:0 7px;font-size:0.8rem;line-height:1.7}
.state.active{color:var(--ok);background:var(--ok-bg)}
.state.scheduled{color:var(--warn);background:var(--warn-bg)}
.state.absent{color:var(--off);background:var(--off-bg)}
.state.unknown,.state.uncovered{color:var(--bad);background:var(--bad-bg)}
.roadmap li{margin:4px 0}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);font-size:0.9rem;color:var(--muted)}`;

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
<style>
${STYLE}
</style>
</head>
<body>
<main>
<section class="hero">
<h1>Epochnotes</h1>
<p>A signed registry of network changes on ${chains.slice(0, -1).map(escapeHtml).join(', ')}${chains.length > 1 ? ' and ' : ''}${escapeHtml(chains.at(-1) ?? '')} — and the checks built on it: what breaks in your code, where, and how to fix it.</p>
<p class="muted">Pre-release. Nothing here has been audited. ${link(REPOSITORY, 'Source on GitHub')} · <a href="registry/versions/1.json">version 1 of the signed log</a></p>
</section>

<section>
<h2>How it works</h2>
<div class="grid">
<div class="card"><h3>Signed entries</h3><p>Each change is an entry built from primary sources — a SIMD or an EIP, the client's code, the chain itself. A version of the registry is a Merkle root, signed by its publisher and anchored by a program on Solana devnet.</p></div>
<div class="card"><h3>Checks</h3><p><code>check repo</code> finds the code a change breaks; <code>check rpc</code> asks a provider, read-only, whether it behaves as the entry says; <code>status</code> reads the activation from each chain at the moment you ask.</p></div>
<div class="card"><h3>Watcher</h3><p>Every day it reads the feature gates agave declares and their state on three Solana clusters, and drafts an entry for what moved outside the registry. A person finishes the draft from the SIMD and signs it.</p></div>
</div>
</section>

<section>
<h2>What the Solana watcher sees</h2>
${watchSection(watch)}
</section>

<section>
<h2>The registry (${sorted.length} entries)</h2>
${sorted.map(entryCard).join('\n')}
</section>

<section>
<h2>Check it yourself</h2>
<pre><code>epochnotes registry read --json --status mainnet-beta   # verified entries and the state of each activation
epochnotes status --chain base                          # every activation the registry names on Base
epochnotes check repo &lt;path&gt;                            # where a change breaks this code
epochnotes check rpc --rpc-url &lt;endpoint&gt;               # does this provider behave as the entry says
epochnotes watch solana                                 # what moved on Solana since the last look</code></pre>
<p class="muted">When it cannot verify what it reads, it refuses to answer rather than guess.</p>
</section>

<section class="roadmap">
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
<li>The first signed version of the registry, published here, and the packages on npm</li>
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
