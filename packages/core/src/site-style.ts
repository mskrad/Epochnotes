export const STYLE = `@font-face{font-family:"Work Sans";src:url("assets/fonts/work-sans-latin.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:optional}
:root{color-scheme:light;--bg:#f5f1e9;--fg:#302c28;--muted:#665d54;--card:#fcfaf5;--line:#d8cdbf;--accent:#934521;--tag:#eae1d4;--code:#eae3d8;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--face:"Work Sans",sans-serif;--ease:cubic-bezier(.16,1,.3,1);--margin:4vw}
*{box-sizing:border-box}
html{scroll-padding-top:24px;scrollbar-color:#98664b #f5f1e9}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--face);-webkit-font-smoothing:antialiased}
::selection{background:#d1b897;color:#302c28}
.wrap{width:100%;max-width:1760px;margin-inline:auto;padding-inline:var(--margin)}
a{color:var(--accent);overflow-wrap:anywhere;text-underline-offset:4px;text-decoration-thickness:1px}
a:focus-visible,summary:focus-visible{outline:2px solid currentColor;outline-offset:5px}
a:hover{text-decoration-thickness:2px}
button,input,summary,a{-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.sr-only,.change-nav input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.skip{opacity:0;position:absolute;left:24px;top:-100px;padding:8px 16px;background:var(--bg);z-index:2}.skip:focus{top:12px;opacity:1}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:78px;padding-block:12px}
.brand{display:flex;gap:16px;align-items:center;color:var(--fg);font-size:34px;font-weight:750;letter-spacing:-.04em;line-height:1;text-decoration:none;flex-shrink:0}.brand img{width:60px;height:54px}
nav{display:flex;align-items:center;gap:32px;font-size:20px;line-height:1.2}nav a{color:var(--fg);text-decoration:none}
.button{display:inline-flex;align-items:center;justify-content:center;gap:16px;padding:13px 24px;text-decoration:none;font-size:27px;font-weight:600;line-height:1.2;border-radius:6px;min-height:56px}
.button.primary{background:#934521;color:#fcfaf5}
nav .button{font-size:20px;min-height:52px;padding-inline:18px;gap:8px}
.chevron,.external{display:inline-block;width:22px;height:22px;vertical-align:middle;flex-shrink:0}
.hero{background:#302c28;color:#f5f1e9;padding-block:34px 16px}
h1{font-size:clamp(52px,7.1vw,124px);font-weight:750;line-height:.9;letter-spacing:-.04em;margin:0;text-wrap:balance}
h1 span{display:block}
.hero .intro{font-size:clamp(22px,2.18vw,38px);line-height:1.1;max-width:900px;margin:8px 0 18px;color:#e4ddd4;letter-spacing:-.025em}
.actions{display:flex;flex-wrap:wrap;gap:16px}
.license{font-size:16px;line-height:1.3;margin:6px 0 10px;color:#e4ddd4}
.explorer{background:#fcfaf5;color:#302c28;border-radius:8px;padding:22px;display:grid;grid-template-columns:22% minmax(0,1fr);gap:26px;min-height:368px;padding-bottom:18px}
.change-nav{margin:0;padding:0 26px 0 0;border:0;border-right:1px solid #d8cdbf;min-width:0}
.change-nav legend{float:left;width:100%;padding:0 6px;margin-bottom:8px;font-size:20px;line-height:1.6;color:#554c44}
.change-nav label{display:block;position:relative;clear:both;font-size:20px;line-height:1.25;cursor:pointer}
.change-nav label span{display:block;padding:10px 12px;border-radius:6px;transition:background-color 160ms var(--ease)}
.change-nav label:has(input:checked) span{background:#eae1d4;font-weight:600;box-shadow:inset 3px 0 #934521}
.change-nav label:has(input:focus-visible) span{outline:2px solid #934521;outline-offset:2px}
.change-panel{display:none;min-width:0}.panel-0{display:block}.explorer:has(input:not(#change-0):checked) .panel-0{display:none}
.change-panel header{position:relative;z-index:2}.change-panel header h2{font-size:32px;line-height:1.05;font-weight:750;letter-spacing:-.035em;margin:0}.change-panel header p{font-size:18px;line-height:1.25;margin:4px 0 0;color:#665d54}
.source-flow{display:grid;grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1.15fr);gap:8px;align-items:stretch;margin-top:52px;margin-left:44px;isolation:isolate;position:relative}
.source-flow>.chevron{align-self:center;width:18px;height:18px;justify-self:center;color:#665d54;position:relative;z-index:3}
.flow-cell{min-width:0;position:relative;padding:12px 18px;display:flex;flex-direction:column;align-items:flex-start;isolation:isolate}.flow-cell::before{content:"";position:absolute;inset:-6px -24px -2px -8px;background:#d1b897b8;transform:skewY(-3deg);transform-origin:left center;z-index:-1;border-radius:4px}.flow-cell:nth-of-type(2)::before{inset:-14px -24px -2px -16px;background:#d1b897c9}.flow-cell.impact::before{inset:-20px 0 -2px -16px;background:#f5f1e9;transform:skewY(-3deg)}
.flow-cell p{font-size:16px;line-height:1.3;margin:0;color:#554c44;max-width:100%;overflow-wrap:anywhere}
.flow-cell h3{font-size:24px;line-height:1.1;font-weight:700;letter-spacing:-.025em;margin:10px 0 2px;overflow-wrap:anywhere}
.flow-cell a{display:inline-flex;align-items:center;gap:8px;margin-top:auto;padding-top:10px;font-size:18px;text-decoration:none;min-height:34px}
.flow-cell a .external{width:20px;height:20px;order:-1}
.impact .impact-statement{font-size:24px;font-weight:700;line-height:1.25;letter-spacing:-.025em;margin-top:12px;color:#302c28}
.example-check{background:#eae7e2;margin:10px 0 0 44px;padding:6px 16px 10px;border-radius:6px}
.example-check p{font-size:16px;line-height:1.35;margin:0 0 4px;color:#554c44}
.example-check pre{padding:0;margin:0;background:transparent;color:#302c28;font-size:16px;line-height:1.6;overflow-x:auto}
.before{color:#8c3f2d}.after{color:#27563d}
.client-link{display:flex;align-items:center;gap:12px;margin:0 0 -4px 44px;min-height:40px;font-size:20px;line-height:1.25;color:#554c44;text-decoration:none}.client-link .chevron{width:16px;height:16px}
.findings{padding-top:12px;padding-bottom:24px}
.findings-heading{display:flex;justify-content:space-between;align-items:center;gap:32px;margin-bottom:12px}
.findings h2{font-size:54px;line-height:1.1;letter-spacing:-.04em;font-weight:750;margin:0}
.findings-heading p{font-size:21px;line-height:1.3;margin:0}
.findings-proof{padding-left:36px;border-left:1px solid #d8cdbf}.findings-proof p{font-size:18px;font-weight:550;max-width:none}.findings-proof .muted{font-weight:400;margin-top:4px;font-size:16px}
.finding{display:grid;grid-template-columns:minmax(0,1fr) 100px;gap:20px;align-items:start;padding-block:8px;border-top:1px solid #dfd5c8}
.finding details{margin:0;padding:0;border:0;min-width:0}
.finding summary{list-style:none;display:grid;grid-template-columns:42px 34% minmax(0,1fr);align-items:center;gap:20px;min-height:38px;font-size:18px;color:#302c28;cursor:pointer}
.finding summary::-webkit-details-marker{display:none}
.finding-project{color:#934521;font-weight:550;line-height:1.2;overflow-wrap:anywhere}
.outcome-text{display:block;color:#665d54;font-weight:400;font-size:16px;margin-top:3px}
.finding-summary{font-size:18px;line-height:1.3}
.outcome-icon{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#934521;border:2px solid #934521}.outcome-icon.merged{color:#fcfaf5;background:#934521}.outcome-icon svg{width:24px;height:24px}
.finding-pr{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:40px;font-size:16px;white-space:nowrap}
.finding-pr .external{width:20px;height:20px}
.finding-body{padding-left:62px;font-size:16px}.finding-body p{margin-block:12px}
.more-findings{margin-top:12px}.more-findings>summary{display:flex;align-items:center;gap:10px;min-height:44px;cursor:pointer;color:#934521;font-size:18px;width:fit-content}.more-findings[open]>summary .chevron{transform:rotate(90deg)}
.findings-method{font-size:16px;color:var(--muted);margin-top:16px;max-width:100ch}
.page-content{padding-bottom:40px}
.edition{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:24px;background:#eae1d4;font-size:16px}.edition a{display:inline-flex;align-items:center;gap:8px}
.page-content section{margin-top:120px}
h2{font-size:48px;line-height:1.1;font-weight:700;letter-spacing:-.035em;margin:0 0 24px;text-wrap:balance}
h3{font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.025em;margin:0 0 12px;text-wrap:balance}
h4{font-size:18px;font-weight:600;line-height:1.4;margin:28px 0 8px}
p{max-width:72ch}li{margin:8px 0}
.muted{color:var(--muted)}.small{font-size:16px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px}
.card{min-width:0;overflow-wrap:anywhere}.card p:last-child{margin-bottom:0}
.entry{padding:0;margin:0 0 12px;background:#eae1d4;border-radius:6px}.entry>summary{display:block;position:relative;padding:24px 60px 24px 24px;list-style:none;color:#302c28}.entry>summary::-webkit-details-marker{display:none}.entry>summary::after{content:"";position:absolute;right:28px;top:32px;width:9px;height:9px;border-right:1.7px solid currentColor;border-bottom:1.7px solid currentColor;transform:rotate(-45deg)}.entry[open]>summary::after{transform:rotate(45deg)}.entry article{padding:0 24px 24px}.entry ul{margin:4px 0;padding-left:20px}.entry h3{font-size:28px;margin:0 0 10px}.entry-canonical{font-size:20px;font-weight:550}
.meta{margin:0;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:16px}
.tag{display:inline-block;background:#f5f1e9;padding:2px 8px;font-size:16px;line-height:1.5;border-radius:3px}.label{font-weight:550}
code{font:.9em var(--mono);background:var(--code);padding:2px 5px;border-radius:3px;overflow-wrap:anywhere}
pre{background:#302c28;color:#f5f1e9;padding:24px;border-radius:6px;overflow-x:auto;font:15px/1.8 var(--mono)}pre code{background:none;color:inherit;padding:0;overflow-wrap:normal}
details{margin-top:24px}summary{cursor:pointer;color:var(--accent);font-size:16px;min-height:36px}
.scroll{overflow-x:auto;max-width:100%;background:#fcfaf5}
table{border-collapse:collapse;width:100%;font-size:16px}th,td{text-align:left;padding:16px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}th{background:#eae1d4;font-weight:600;font-size:16px;white-space:nowrap}
.state{display:inline-block;border-radius:3px;padding:2px 7px;font-size:16px;white-space:nowrap;background:#eae1d4;color:#554c44}.state.active{color:#27563d;background:#e2ecdf}.state.scheduled{color:#775122;background:#efe1c7}.state.unknown,.state.uncovered{color:#943c39;background:#f2dfd9}
.roadmap .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
footer{margin-top:100px;padding-top:24px;font-size:16px;color:var(--muted)}.footer-brand{display:flex;align-items:center;justify-content:space-between;font-size:clamp(48px,8vw,124px);font-weight:750;line-height:1;letter-spacing:-.04em;color:#302c28;text-decoration:none}.footer-brand .chevron{width:48px;height:48px}
.agent-capabilities{margin-block:36px;display:grid;gap:24px}.agent-capabilities>div{display:grid;grid-template-columns:28% minmax(0,1fr);gap:36px;align-items:baseline}.agent-capabilities h3{font-size:28px;margin:0}.agent-capabilities p{margin:0}
.installation{padding:32px;background:#eae1d4;margin-block:36px}.installation>h3{margin-top:0}.agent-installers{margin-block:28px}.agent-installers>details{margin:0;padding:12px 0}.agent-installers>details>summary,.trust-setup>summary{font-size:20px;font-weight:550;min-height:44px}.trust-setup{margin-top:24px}.example-questions{list-style:none;margin:20px 0;padding:0;max-width:72ch}.example-questions li{background:#eae1d4;padding:16px 20px;font-size:20px;line-height:1.45;margin-block:8px}.agent-answer{margin-top:36px;padding:32px;background:#302c28;color:#f5f1e9;border-radius:6px}.agent-answer .muted{color:#d1b897}.agent-answer pre{margin:0;padding:0;white-space:pre-wrap;overflow-wrap:anywhere}.agent-answer pre code{overflow-wrap:anywhere}
.scroll-hint{display:none}.scroll:focus-visible{outline:2px solid #934521;outline-offset:5px}#watcher table{min-width:700px}.roadmap .card{background:#eae1d4;padding:28px}

@media(hover:hover) and (pointer:fine){.button:hover{background:#78391e;transform:translateY(-1px)}.change-nav label:hover span{background:#eae1d4}.finding summary:hover .finding-project,.client-link:hover{text-decoration:underline;text-underline-offset:4px}}
.button{transition:transform 160ms var(--ease),background-color 160ms var(--ease)}.button:active{transform:scale(.98)}
@media(prefers-reduced-motion:no-preference){.hero h1 span,.hero .intro,.hero .actions,.hero .license,.explorer,.source-flow .flow-cell,.example-check,.client-link{animation:arrive 480ms var(--ease) both}.hero h1 span:nth-child(2){animation-delay:50ms}.hero .intro{animation-delay:90ms}.hero .actions{animation-delay:130ms}.hero .license{animation-delay:160ms}.explorer{animation-delay:180ms}.source-flow .flow-cell:nth-of-type(2){animation-delay:220ms}.source-flow .flow-cell:nth-of-type(3){animation-delay:260ms}.example-check{animation-delay:300ms}.client-link{animation-delay:320ms}@keyframes arrive{from{opacity:.6;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}}
@media(max-width:1100px){nav{gap:20px;font-size:16px}nav .button{font-size:16px}.brand{font-size:28px;gap:10px}.brand img{width:48px;height:44px}.flow-cell{padding:14px}.flow-cell p,.flow-cell a{font-size:16px}.flow-cell h3{font-size:23px}.impact .impact-statement{font-size:24px}.source-flow,.example-check,.client-link{margin-left:0}.explorer{grid-template-columns:20% minmax(0,1fr);gap:22px}.change-nav{padding-right:18px}.change-nav label,.change-nav legend{font-size:18px}.findings h2{font-size:42px}.findings-proof{padding-left:24px}.finding summary{grid-template-columns:32px 38% minmax(0,1fr);gap:14px}.finding-summary{font-size:16px}}
@media(max-width:1000px){:root{--margin:20px}.masthead{flex-wrap:wrap;gap:12px;padding-block:14px}.brand{font-size:28px}.brand img{width:40px;height:38px}nav{width:100%;justify-content:space-between;gap:8px;font-size:14px}nav>a{display:inline-flex;align-items:center;min-height:40px}nav .button{display:none}.hero{padding-block:32px 20px}h1{font-size:clamp(38px,8.6vw,65px);line-height:1;letter-spacing:-.04em}.hero .intro{font-size:22px;line-height:1.3;max-width:38ch;margin:20px 0 24px}.desktop-break{display:none}.button{font-size:20px;min-height:52px;padding:13px 20px;gap:12px}.license{font-size:16px;margin:12px 0 24px}.explorer{display:block;padding:18px;min-height:0}.change-nav{border:0;padding:0;display:flex;flex-wrap:wrap;gap:4px;margin-bottom:22px}.change-nav legend{float:none;padding:0;margin-bottom:8px;font-size:16px}.change-nav label{font-size:16px;line-height:1.25}.change-nav label span{padding:12px}.change-nav label:has(input:checked) span{box-shadow:none;background:#d1b897}.change-panel header h2{font-size:30px}.change-panel header p{font-size:16px}.source-flow{display:grid;grid-template-columns:1fr;gap:8px;margin-top:24px}.source-flow>.chevron{transform:rotate(90deg);width:16px;height:16px}.flow-cell{padding:18px 16px;gap:0;margin-inline:4px}.flow-cell::before,.flow-cell:nth-of-type(2)::before,.flow-cell.impact::before{inset:0;transform:skewY(-1.5deg)}.flow-cell h3{font-size:24px;margin-top:6px}.flow-cell p,.flow-cell a{font-size:16px}.flow-cell a{min-height:44px;padding-top:10px}.impact .impact-statement{font-size:24px;line-height:1.25}.example-check{padding:14px;margin-top:12px}.example-check pre{font-size:12px;line-height:1.8}.client-link{font-size:16px;margin-top:10px;min-height:44px}.findings{padding-top:32px;padding-bottom:28px}.findings-heading{display:block;margin-bottom:22px}.findings h2{font-size:36px}.findings-heading p{font-size:18px;margin-top:8px}.findings-proof{border:0;padding:0;margin-top:20px}.findings-proof p{font-size:16px}.finding{grid-template-columns:minmax(0,1fr);gap:0;padding-block:16px}.finding summary{grid-template-columns:28px minmax(0,1fr);gap:10px;font-size:16px}.finding-summary{grid-column:2;margin-top:4px;font-size:16px}.finding-pr{justify-content:flex-start;margin-left:38px;min-height:44px;width:fit-content}.outcome-icon{width:26px;height:26px;align-self:start}.outcome-icon svg{width:20px;height:20px}.finding-body{padding-left:38px}.finding-project{font-size:16px}.outcome-text{font-size:16px}.findings-method{font-size:16px;margin-top:20px}.edition{display:block;padding:20px}.edition>span{display:block}.edition>span+span{margin-top:12px}.page-content section{margin-top:80px}.grid,.roadmap .grid{grid-template-columns:1fr;gap:32px}h2{font-size:36px}h3{font-size:26px}.entry>summary{padding:20px 44px 20px 20px}.entry>summary::after{right:20px;top:28px}.entry article{padding:0 20px 20px}.entry h3{font-size:24px}.entry .meta{font-size:16px}.installation,.agent-answer{padding:20px}.agent-capabilities>div{grid-template-columns:1fr;gap:8px}.agent-capabilities h3{font-size:24px}.example-questions li{font-size:18px;padding:16px}.agent-answer pre{font-size:13px}.roadmap .card{padding:24px}.footer-brand .chevron{width:32px;height:32px}.meta{font-size:16px}.scroll{max-width:100%}th,td{padding:12px}pre{padding:18px;font-size:13px}footer{margin-top:72px}}
@media(min-width:641px) and (max-width:1000px){.source-flow{margin-top:36px;grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1.15fr);gap:8px}.source-flow>.chevron{transform:none}.flow-cell::before,.flow-cell:nth-of-type(2)::before,.flow-cell.impact::before{inset:-6px -12px;transform:skewY(-2deg)}.flow-cell.impact::before{inset:-14px 0 -6px -10px}.flow-cell{padding:16px 12px;margin-inline:0}.source-flow .flow-cell h3{font-size:24px}.change-nav{gap:8px}.hero .intro{max-width:52ch}.grid{grid-template-columns:1fr}.agent-capabilities>div{grid-template-columns:28% minmax(0,1fr);gap:24px}.findings-heading{display:flex}.findings-proof{max-width:45%;margin-top:0}}
@media(max-width:760px){.scroll-hint{display:block;font-size:16px;color:#665d54}}
@media(max-width:360px){h1{font-size:9.5vw}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
