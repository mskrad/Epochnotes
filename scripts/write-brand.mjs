import { mkdirSync, writeFileSync } from 'node:fs';

import { brandSvg, STRATA } from '../packages/core/dist/site-brand.js';

const directory = new URL('../assets/brand/', import.meta.url);
mkdirSync(directory, { recursive: true });
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" role="img" aria-label="Epochnotes geological strata">${STRATA}</svg>\n`;
for (const [name, content] of [
  ['mark.svg', icon],
  ['github-banner.svg', brandSvg(1280, 640, 'banner')],
  ['social.svg', brandSvg(1280, 640, 'social')],
  ['style-board.svg', brandSvg(1280, 1000, 'board')],
])
  writeFileSync(new URL(name, directory), content);
console.log('Brand SVG assets written to assets/brand');
