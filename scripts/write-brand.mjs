import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { brandSvg, STRATA } from '../packages/core/dist/site-brand.js';

const directory = new URL('../assets/brand/', import.meta.url);
const font = `data:font/woff2;base64,${readFileSync(new URL('../assets/fonts/work-sans-latin.woff2', import.meta.url)).toString('base64')}`;
mkdirSync(directory, { recursive: true });
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" role="img" aria-label="Epochnotes geological strata">${STRATA}</svg>\n`;
const projectLogo = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="Epochnotes geological strata on white"><rect width="1024" height="1024" fill="#ffffff"/><g transform="translate(122 122) scale(2.6)">${STRATA}</g></svg>\n`;
for (const [name, content] of [
  ['mark.svg', icon],
  ['project-logo.svg', projectLogo],
  ['github-banner.svg', brandSvg(1280, 640, 'banner', font)],
  ['social.svg', brandSvg(1280, 640, 'social', font)],
  ['style-board.svg', brandSvg(1280, 1000, 'board', font)],
])
  writeFileSync(new URL(name, directory), content);
console.log('Brand SVG assets written to assets/brand');
