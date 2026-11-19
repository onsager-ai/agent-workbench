#!/usr/bin/env node
// Generator for the Agent Workbench brand kit. Every file in this directory
// except README.md, package*.json and this script is derived from the mark
// geometry below and outlined Inter 400 glyphs. Output is deterministic.
//
// Usage: npm install && npm run generate (from assets/brand/)

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as wawoff2 from 'wawoff2';
import opentype from 'opentype.js';
import { Resvg } from '@resvg/resvg-js';

const OUT = dirname(fileURLToPath(import.meta.url));
const NAME = 'Agent Workbench';
const SLUG = 'agent-workbench';
const TAGLINE = 'Manager and Worker skills for Codex and Claude Code.';
const NAVY = '#1E3A5F'; // shared onsager-ai accent (Duhem, Tolmap)
const INK_LIGHT = '#111111';
const INK_DARK = '#FFFFFF';

// ---------------------------------------------------------------------
// Mark geometry, 32x32 grid shared with Duhem, Ostrom, Semon and Tolmap.
// The 10x10 centre at (11, 11) is the Manager; the three 4x4 squares on
// the bottom edge are Workers, 5 units below the centre.
// ---------------------------------------------------------------------
const CANVAS = 32;
const UNIT = 4; // family stroke thickness
const MARK = [
  { x: 11, y: 11, w: 10, h: 10 }, // Manager
  { x: 2, y: 26, w: 4, h: 4 }, // Worker
  { x: 14, y: 26, w: 4, h: 4 }, // Worker
  { x: 26, y: 26, w: 4, h: 4 }, // Worker
];
const VIS = { x1: 2, y1: 11, x2: 30, y2: 30 }; // visible ink bounds
const VIS_W = VIS.x2 - VIS.x1;
const VIS_H = VIS.y2 - VIS.y1;

// Favicons and icon PNGs move the ink up by FAVICON_SHIFT units so it is
// vertically centred in its square instead of sitting on the family
// canvas position. Rasters round the shift to whole pixels.
const FAVICON_SHIFT = (CANVAS - VIS_H) / 2 - VIS.y1; // -4.5

// 16 px and 48 px are fractional scales (0.5 and 1.5 px per unit); these
// hand-snapped, vertically centred whole-pixel grids keep the mark
// mirror-symmetric there.
const SNAPPED = {
  16: [
    { x: 5, y: 3, w: 6, h: 6 },
    { x: 1, y: 11, w: 2, h: 2 },
    { x: 7, y: 11, w: 2, h: 2 },
    { x: 13, y: 11, w: 2, h: 2 },
  ],
  48: [
    { x: 16, y: 9, w: 16, h: 16 },
    { x: 3, y: 32, w: 6, h: 6 },
    { x: 21, y: 32, w: 6, h: 6 },
    { x: 39, y: 32, w: 6, h: 6 },
  ],
};

const rects = (list) =>
  list.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`).join('');
const r3 = (n) => Math.round(n * 1000) / 1000;

function svg({ w, h, title, body, size }) {
  const dims = size ? ` width="${r3(size[0])}" height="${r3(size[1])}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r3(w)} ${r3(h)}"${dims} role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
}

// ---------------------------------------------------------------------
// Type: outlined Inter 400, so SVGs render the same without Inter.
// ---------------------------------------------------------------------
async function loadInter() {
  const woff2 = readFileSync(
    join(OUT, 'node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2')
  );
  const ttf = Buffer.from(await wawoff2.decompress(woff2));
  return opentype.parse(ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength));
}

function text(font, str, size, trackingEm = -0.005) {
  const scale = size / font.unitsPerEm;
  let x = 0;
  let prev = null;
  const parts = [];
  let box = null;
  for (const ch of str) {
    const g = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, g) * scale;
    const p = g.getPath(x, 0, size);
    const d = p.toPathData(3);
    if (d) {
      parts.push(d);
      const b = p.getBoundingBox();
      box = box
        ? { x1: Math.min(box.x1, b.x1), y1: Math.min(box.y1, b.y1), x2: Math.max(box.x2, b.x2), y2: Math.max(box.y2, b.y2) }
        : b;
    }
    x += g.advanceWidth * scale + trackingEm * size;
    prev = g;
  }
  return { d: parts.join(''), box, cap: font.tables.os2.sCapHeight * scale };
}

// ---------------------------------------------------------------------
// Vector assets
// ---------------------------------------------------------------------
function markSvg(fill) {
  return svg({
    w: CANVAS,
    h: CANVAS,
    size: [CANVAS, CANVAS],
    title: NAME,
    body: `<g fill="${fill}">${rects(MARK)}</g>`,
  });
}

function faviconSvg() {
  return svg({
    w: CANVAS,
    h: CANVAS,
    title: NAME,
    body: `<style>g{fill:${INK_LIGHT}}@media(prefers-color-scheme:dark){g{fill:${INK_DARK}}}</style><g transform="translate(0 ${FAVICON_SHIFT})">${rects(MARK)}</g>`,
  });
}

function wordmarkSvg(font) {
  const t = text(font, NAME, 64);
  const pad = 4;
  const w = t.box.x2 - t.box.x1 + pad * 2;
  const h = t.box.y2 - t.box.y1 + pad * 2;
  return svg({
    w,
    h,
    size: [w / 2, h / 2],
    title: NAME,
    body: `<path fill="currentColor" transform="translate(${r3(pad - t.box.x1)} ${r3(pad - t.box.y1)})" d="${t.d}"/>`,
  });
}

// Horizontal lockup: the visible mark spans cap height to baseline, and
// the gap to the wordmark is one scaled 4-unit stroke.
function lockupSvg(font, fill) {
  const t = text(font, NAME, 64);
  const s = t.cap / VIS_H;
  const pad = 2 * s;
  const markX = pad - VIS.x1 * s;
  const capTop = Math.min(-t.cap, t.box.y1); // ascenders may rise above caps
  const baseY = pad - capTop;
  const markY = baseY - VIS.y2 * s;
  const textX = pad + VIS_W * s + UNIT * s - t.box.x1;
  const w = textX + t.box.x2 + pad;
  const h = baseY + t.box.y2 + pad;
  return svg({
    w,
    h,
    size: [w / 2, h / 2],
    title: NAME,
    body: `<g fill="${fill}"><g transform="translate(${r3(markX)} ${r3(markY)}) scale(${r3(s)})">${rects(MARK)}</g><path transform="translate(${r3(textX)} ${r3(baseY)})" d="${t.d}"/></g>`,
  });
}

// ---------------------------------------------------------------------
// Raster assets
// ---------------------------------------------------------------------
function png(svgText, width) {
  return new Resvg(svgText, { fitTo: { mode: 'width', value: width } }).render();
}

function rasterMark(size) {
  const body = SNAPPED[size]
    ? `<g fill="#000000" shape-rendering="crispEdges">${rects(SNAPPED[size])}</g>`
    : `<g fill="#000000" shape-rendering="crispEdges" transform="translate(0 ${Math.round(FAVICON_SHIFT * (size / CANVAS))}) scale(${size / CANVAS})">${rects(MARK)}</g>`;
  const out = new Resvg(svg({ w: size, h: size, title: NAME, body }), {
    fitTo: { mode: 'original' },
  }).render();
  // The mark is left-right symmetric; fail if a raster is not.
  const px = out.pixels;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size / 2; x++) {
      const a = px[(y * size + x) * 4 + 3];
      const b = px[(y * size + (size - 1 - x)) * 4 + 3];
      if (a !== b) throw new Error(`${size}px mark is asymmetric at row ${y}, column ${x}`);
    }
  }
  return out.asPng();
}

function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size, o);
    head.writeUInt8(size, o + 1);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

// White mark centred by its visible ink on a navy plate, at a whole
// number of pixels per grid unit, with the ink about 60% of plate width.
function iconSvg(size, radius) {
  const s = Math.round((0.6 * size) / VIS_W);
  const tx = Math.round((size - VIS_W * s) / 2 - VIS.x1 * s);
  const ty = Math.round((size - VIS_H * s) / 2 - VIS.y1 * s);
  const plate = radius
    ? `<rect width="${size}" height="${size}" rx="${radius}" fill="${NAVY}"/>`
    : `<rect width="${size}" height="${size}" fill="${NAVY}"/>`;
  return svg({
    w: size,
    h: size,
    title: NAME,
    body: `${plate}<g fill="#FFFFFF" shape-rendering="crispEdges" transform="translate(${tx} ${ty}) scale(${s})">${rects(MARK)}</g>`,
  });
}

// 1280x640 GitHub social preview: mark above wordmark, tagline below.
function socialSvg(font) {
  const W = 1280;
  const H = 640;
  const s = 8;
  const word = text(font, NAME, 104);
  const tag = text(font, TAGLINE, 38, 0);
  const gap = 2 * UNIT * s;
  const tagGap = 44;
  const block = VIS_H * s + gap + word.cap + tagGap + tag.cap;
  const top = Math.round((H - block) / 2);
  const mx = Math.round((W - VIS_W * s) / 2 - VIS.x1 * s);
  const my = top - VIS.y1 * s;
  const wordBase = top + VIS_H * s + gap + word.cap;
  const tagBase = wordBase + tagGap + tag.cap;
  const cx = (t) => r3((W - (t.box.x2 - t.box.x1)) / 2 - t.box.x1);
  return svg({
    w: W,
    h: H,
    title: `${NAME}: ${TAGLINE}`,
    body: `<rect width="${W}" height="${H}" fill="#FFFFFF"/><g fill="#000000" shape-rendering="crispEdges" transform="translate(${mx} ${my}) scale(${s})">${rects(MARK)}</g><path fill="#000000" transform="translate(${cx(word)} ${r3(wordBase)})" d="${word.d}"/><path fill="${NAVY}" transform="translate(${cx(tag)} ${r3(tagBase)})" d="${tag.d}"/>`,
  });
}

// ---------------------------------------------------------------------
async function main() {
  const font = await loadInter();
  const write = (name, data) => writeFileSync(join(OUT, name), data);

  write(`${SLUG}-mark.svg`, markSvg('currentColor'));
  write(`${SLUG}-mark-light.svg`, markSvg(INK_LIGHT));
  write(`${SLUG}-mark-dark.svg`, markSvg(INK_DARK));
  write(`${SLUG}-wordmark.svg`, wordmarkSvg(font));
  const lockups = {
    '': lockupSvg(font, 'currentColor'),
    '-light': lockupSvg(font, INK_LIGHT),
    '-dark': lockupSvg(font, INK_DARK),
  };
  for (const [suffix, text] of Object.entries(lockups)) write(`${SLUG}-lockup${suffix}.svg`, text);
  write(`${SLUG}-lockup-light.png`, png(lockups['-light'], 960).asPng());
  write(`${SLUG}-lockup-dark.png`, png(lockups['-dark'], 960).asPng());
  write('favicon.svg', faviconSvg());

  const icoEntries = [];
  for (const size of [16, 32, 48, 64, 192, 512]) {
    const data = rasterMark(size);
    write(`${SLUG}-${size}.png`, data);
    if (size <= 48) icoEntries.push({ size, data });
  }
  write('favicon.ico', ico(icoEntries));

  write(`${SLUG}-app-icon.png`, png(iconSvg(1024, 228), 1024).asPng());
  write(`${SLUG}-apple-touch-icon.png`, png(iconSvg(180, 0), 180).asPng());
  write('social-preview.png', png(socialSvg(font), 1280).asPng());

  copyFileSync(join(OUT, 'node_modules/@fontsource/inter/LICENSE'), join(OUT, 'Inter-OFL.txt'));
}

await main();
