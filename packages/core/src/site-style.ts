export const STYLE = `:root{color-scheme:light dark;--bg:#f5f1e9;--fg:#302c28;--muted:#74675a;--card:#fcfaf5;--line:#d8cdbf;--accent:#934521;--tag:#eae1d4;--ok:#33634b;--ok-bg:#e2ecdf;--warn:#775122;--warn-bg:#efe1c7;--off:#685e55;--off-bg:#e9e4dc;--bad:#943c39;--bad-bg:#f2dfd9;--code:#eae3d8;--serif:Georgia,"Times New Roman",serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#211f1c;--fg:#f0e9df;--muted:#c0b1a0;--card:#2b2824;--line:#4b433a;--accent:#eda579;--tag:#43382d;--ok:#b4d5b8;--ok-bg:#2c3d30;--warn:#ebcb91;--warn-bg:#453820;--off:#c3b7aa;--off-bg:#3b3530;--bad:#f0aaa0;--bad-bg:#4c2d29;--code:#36302a}.brand svg path:first-child,.brand svg path:last-child,.specimen svg path:first-child,.specimen svg path:last-child{fill:#a89c8d}}
*{box-sizing:border-box}
html{scroll-padding-top:24px}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:#d1b897;color:#302c28}
main{max-width:1184px;margin:auto;padding:0 32px 48px}
a{color:var(--accent);overflow-wrap:anywhere;text-underline-offset:4px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:5px}
.skip{position:absolute;left:24px;top:-100px;padding:8px 16px;background:var(--card);z-index:2}.skip:focus{top:12px}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:24px 0;border-bottom:1px solid var(--line)}
.brand{display:flex;gap:10px;align-items:center;color:var(--fg);font:26px/1 var(--serif);text-decoration:none}.brand svg{width:42px;height:42px}
nav{display:flex;flex-wrap:wrap;gap:24px;font-size:14px}nav a{color:var(--fg);text-decoration:none}
.hero{display:grid;grid-template-columns:1.45fr 1fr;gap:48px;align-items:center;padding:80px 0 52px}
.eyebrow,.section-label,.specimen-caption{font:12px/1.6 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.eyebrow{margin:0 0 24px}
h1{font:clamp(48px,6vw,82px)/1.04 var(--serif);letter-spacing:-.045em;margin:0 0 24px;text-wrap:balance}
.hero .intro{font-size:18px;line-height:1.65;max-width:54ch;margin:0 0 28px;color:var(--muted);text-wrap:pretty}
.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.button{display:inline-block;padding:11px 20px;border:1px solid var(--line);border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;color:var(--fg)}
.button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.button:hover{border-color:var(--accent)}
.specimen{margin:0;text-align:center;position:relative;padding:32px 24px;background:var(--card);border:1px solid var(--line);border-radius:48% 48% 4px 4px}
.specimen svg{display:block;width:100%;max-width:340px;margin:auto}.specimen-caption{margin-top:20px}
.edition{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:var(--muted);font:12px/1.7 var(--mono)}
section:not(.hero){margin-top:72px}
.section-label{margin:0 0 10px}
h2{font:clamp(30px,4vw,42px)/1.15 var(--serif);letter-spacing:-.025em;margin:0 0 28px;text-wrap:balance}
h3{font:26px/1.2 var(--serif);margin:0 0 12px;text-wrap:balance}
h4{margin:22px 0 8px;font:12px/1.6 var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
p{max-width:72ch}li{margin:8px 0}
.muted{color:var(--muted)}.small{font-size:14px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}
.card{min-width:0;overflow-wrap:anywhere;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:28px}
.grid .card{border-top:3px solid #d1b897}.grid .card:nth-child(2){border-top-color:#98664b}.grid .card:nth-child(3){border-top-color:#bc6239}
.card p:last-child{margin-bottom:0}
.entry{margin-bottom:20px;border-left:4px solid #d1b897}.entry:nth-of-type(3n+2){border-left-color:#98664b}.entry:nth-of-type(3n){border-left-color:#bc6239}
.entry h3{font-size:28px}.entry ul{margin:4px 0;padding-left:20px}
.meta{margin:0;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px}
.tag{display:inline-block;background:var(--tag);border-radius:3px;padding:2px 8px;font:12px/1.6 var(--mono)}
.label{font:0.85em var(--mono)}
code{font:0.85em var(--mono);background:var(--code);padding:2px 5px;border-radius:3px;overflow-wrap:anywhere}
pre{background:var(--fg);color:var(--bg);padding:24px;border-radius:4px;overflow-x:auto;font:13px/1.8 var(--mono)}pre code{background:none;color:inherit;padding:0;overflow-wrap:normal}
details{margin-top:24px;padding-top:16px;border-top:1px solid var(--line)}summary{cursor:pointer;color:var(--accent);font-size:14px}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:4px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:16px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}th{background:var(--tag);color:var(--muted);font:11px/1.5 var(--mono);text-transform:uppercase;letter-spacing:.04em}
.state{display:inline-block;border-radius:3px;padding:2px 7px;font:12px/1.6 var(--mono);white-space:nowrap}
.state.active{color:var(--ok);background:var(--ok-bg)}.state.scheduled{color:var(--warn);background:var(--warn-bg)}.state.absent{color:var(--off);background:var(--off-bg)}.state.unknown,.state.uncovered{color:var(--bad);background:var(--bad-bg)}
.roadmap .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
footer{margin-top:72px;padding-top:24px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
@media(max-width:760px){main{padding:0 20px 32px}.masthead{align-items:flex-start;gap:16px;flex-direction:column}nav{gap:20px}.hero{grid-template-columns:1fr;gap:32px;padding:48px 0 32px}.specimen{width:100%;max-width:340px;margin:auto;padding:24px}.specimen svg{max-width:220px}section:not(.hero){margin-top:48px}.grid,.roadmap .grid{grid-template-columns:1fr}.card{padding:22px}h3,.entry h3{font-size:24px}.edition{display:block}.edition span{display:block}.scroll{max-width:100%}th,td{padding:12px}pre{padding:18px}}
@media(prefers-reduced-motion:no-preference){a{transition:color .15s,border-color .15s}}`;
