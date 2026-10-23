export const STRATA = `<path fill="#302c28" d="M38 111C51 76 88 78 113 50C145 15 189 16 207 53C215 74 244 72 260 110C222 125 202 106 172 109C122 121 86 83 38 111Z"/>
<path fill="#d1b897" d="M32 122C81 92 120 132 172 121C208 112 231 136 267 119L270 157C219 176 190 153 151 167C98 185 61 152 17 168C18 150 25 133 32 122Z"/>
<path fill="#98664b" d="M15 180C65 163 95 195 153 179C189 169 209 185 241 173L221 215C184 237 144 215 111 224C75 234 47 216 17 221C7 206 8 190 15 180Z"/>
<path fill="#bc6239" d="M252 172L278 155C292 179 283 199 264 211L239 225L228 215Z"/>
<path fill="#302c28" d="M22 233C63 230 78 247 113 237C151 226 183 250 220 228L249 242C222 261 203 286 179 282L63 269C41 267 30 252 22 233Z"/>`;

export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" aria-hidden="true" focusable="false">${STRATA}</svg>`;

const FACE = '"Work Sans",Helvetica,Arial,sans-serif';

/**
 * The README cover, the social preview and the style board, drawn like the homepage: a limestone masthead
 * carrying the mark, then a charcoal hero. The mark stays on limestone because its outer strata are
 * charcoal and would vanish on the hero. `fontDataUrl` embeds Work Sans, since an SVG shown as an image
 * cannot fetch a font; without it the artwork falls back to Helvetica or Arial.
 */
export function brandSvg(
  width: number,
  height: number,
  kind: 'banner' | 'social' | 'board',
  fontDataUrl?: string,
): string {
  const board = kind === 'board';
  const total = board ? 1000 : 640;
  const font =
    fontDataUrl === undefined
      ? ''
      : `<style>@font-face{font-family:"Work Sans";src:url(${fontDataUrl}) format("woff2");font-weight:100 900}</style>\n`;
  const swatches: [string, string][] = [
    ['#302c28', 'Charcoal'],
    ['#f5f1e9', 'Limestone'],
    ['#d1b897', 'Sandstone'],
    ['#98664b', 'Clay'],
    ['#bc6239', 'Copper'],
    ['#934521', 'Ink copper'],
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1280 ${total}" role="img" aria-labelledby="title desc">
<title id="title">Epochnotes: keep up with network changes</title>
<desc id="desc">The Epochnotes strata mark on a limestone masthead above a charcoal panel: know what breaks in your code, with fixes tied to signed records and primary sources.</desc>
${font}<rect width="1280" height="${total}" fill="#f5f1e9"/>
<g transform="translate(64 26) scale(0.2)">${STRATA}</g>
<text x="138" y="70" fill="#302c28" font-family='${FACE}' font-size="36" font-weight="700" letter-spacing="-0.7">Epochnotes</text>
<text x="1216" y="68" fill="#665d54" font-family='${FACE}' font-size="20" text-anchor="end">Free, open source, MIT.</text>
<path d="M0 111.5H1280" stroke="#d8cdbf"/>
<rect y="112" width="1280" height="528" fill="#302c28"/>
<text fill="#f5f1e9" font-family='${FACE}' font-size="108" font-weight="750" letter-spacing="-4.3"><tspan x="60" y="262">Keep up with</tspan><tspan x="60" y="372">network changes.</tspan></text>
<text fill="#e4ddd4" font-family='${FACE}' font-size="30" letter-spacing="-0.6"><tspan x="64" y="448">Know what breaks in your code, with fixes tied to</tspan><tspan x="64" y="488">signed records and primary sources.</tspan></text>
<rect x="64" y="532" width="360" height="52" rx="6" fill="#934521"/>
<text x="244" y="566" fill="#fcfaf5" font-family='${FACE}' font-size="22" font-weight="600" text-anchor="middle">Solana · Ethereum · Base</text>
${
  board
    ? `<text x="64" y="700" fill="#302c28" font-family='${FACE}' font-size="34" font-weight="700" letter-spacing="-0.7">The visual language</text>
${swatches.map(([color, name], i) => `<rect x="${64 + i * 192}" y="730" width="176" height="84" rx="6" fill="${color}" stroke="#d8cdbf"/><text x="${64 + i * 192}" y="842" fill="#302c28" font-family='${FACE}' font-size="17" font-weight="600">${name}</text><text x="${64 + i * 192}" y="866" fill="#665d54" font-family="ui-monospace,Menlo,monospace" font-size="15">${color}</text>`).join('')}
<text x="64" y="930" fill="#665d54" font-family='${FACE}' font-size="20">Work Sans throughout. Charcoal hero, limestone reading surfaces, ink-copper actions.</text>`
    : ''
}
</svg>\n`;
}
