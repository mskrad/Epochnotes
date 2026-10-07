export const STRATA = `<path fill="#302c28" d="M38 111C51 76 88 78 113 50C145 15 189 16 207 53C215 74 244 72 260 110C222 125 202 106 172 109C122 121 86 83 38 111Z"/>
<path fill="#d1b897" d="M32 122C81 92 120 132 172 121C208 112 231 136 267 119L270 157C219 176 190 153 151 167C98 185 61 152 17 168C18 150 25 133 32 122Z"/>
<path fill="#98664b" d="M15 180C65 163 95 195 153 179C189 169 209 185 241 173L221 215C184 237 144 215 111 224C75 234 47 216 17 221C7 206 8 190 15 180Z"/>
<path fill="#bc6239" d="M252 172L278 155C292 179 283 199 264 211L239 225L228 215Z"/>
<path fill="#302c28" d="M22 233C63 230 78 247 113 237C151 226 183 250 220 228L249 242C222 261 203 286 179 282L63 269C41 267 30 252 22 233Z"/>`;

export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" aria-hidden="true" focusable="false">${STRATA}</svg>`;

export function brandSvg(width: number, height: number, kind: 'banner' | 'social' | 'board'): string {
  const board = kind === 'board';
  const titleSize = board ? 72 : 94;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1280 ${board ? 1000 : 640}" role="img" aria-labelledby="title desc">
<title id="title">Epochnotes — read the layers of change</title>
<desc id="desc">A geological cross-section in charcoal, sandstone, clay and copper. A field journal for network changes.</desc>
<rect width="1280" height="${board ? 1000 : 640}" fill="#f5f1e9"/>
<path d="M48 48H1232M48 592H1232" stroke="#d8cdbf"/>
<text x="64" y="85" fill="#705f50" font-family="monospace" font-size="14" letter-spacing="3">A FIELD JOURNAL FOR NETWORK CHANGES</text>
<g transform="translate(865 150) scale(1.05)">${STRATA}</g>
<text x="64" y="290" fill="#302c28" font-family="Georgia,serif" font-size="${titleSize}" letter-spacing="-4">Epochnotes</text>
<text x="68" y="355" fill="#705f50" font-family="system-ui,sans-serif" font-size="26">Read the layers of change.</text>
<text x="68" y="405" fill="#705f50" font-family="system-ui,sans-serif" font-size="19">Signed records. Clear impact. Checks you can run.</text>
<text x="64" y="553" fill="#705f50" font-family="monospace" font-size="14" letter-spacing="2">SOLANA / ETHEREUM / BASE</text>
<text x="1030" y="553" fill="#705f50" font-family="monospace" font-size="14">epochnotes</text>
${
  board
    ? `<text x="64" y="665" fill="#302c28" font-family="Georgia,serif" font-size="34">The visual language</text>
${['#302c28', '#f5f1e9', '#d1b897', '#98664b', '#bc6239'].map((color, i) => `<rect x="${64 + i * 230}" y="700" width="208" height="84" rx="4" fill="${color}" stroke="#d8cdbf"/><text x="${64 + i * 230}" y="817" fill="#705f50" font-family="monospace" font-size="16">${color}</text>`).join('')}
<text x="64" y="880" fill="#302c28" font-family="Georgia,serif" font-size="30">Editorial headings / quiet interfaces / precise data</text>
<text x="64" y="930" fill="#705f50" font-family="system-ui,sans-serif" font-size="19">Organic strata. Open space. Copper marks the point of change.</text>`
    : ''
}
</svg>\n`;
}
