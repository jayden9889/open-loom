#!/usr/bin/env node
/**
 * Rasterise the app icon + tray template icons from assets/icon.svg.
 * Outputs:
 *   assets/icon.png                 1024x1024 app icon
 *   assets/tray/trayTemplate.png    22x22 monochrome ring-dot (macOS template)
 *   assets/tray/trayTemplate@2x.png 44x44
 * Template icons must be pure black + alpha; macOS tints them automatically.
 */
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');

function render(svg, size, outFile) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, png);
  console.log(`wrote ${path.relative(root, outFile)} (${size}x${size}, ${png.length} bytes)`);
}

// 1. App icon from the checked-in SVG.
const iconSvg = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
render(iconSvg, 1024, path.join(assets, 'icon.png'));

// 2. Tray template: ring with a nested record dot, black on transparent.
//    Drawn at 44 with a 2x fitTo for crispness at both densities.
const traySvg = `<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
  <path d="M 29.9 15.9 A 11 11 0 1 0 33 22" stroke="#000000" stroke-width="4" stroke-linecap="round" fill="none"/>
  <circle cx="31.6" cy="17.4" r="3.4" fill="#000000"/>
</svg>`;
render(traySvg, 22, path.join(assets, 'tray', 'trayTemplate.png'));
render(traySvg, 44, path.join(assets, 'tray', 'trayTemplate@2x.png'));
