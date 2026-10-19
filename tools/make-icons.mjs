// Generates app icons for Windows (png/ico) and Android (mipmaps, adaptive icon) from build-resources/icon.svg
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';

const svg = fs.readFileSync('build-resources/icon.svg', 'utf8');
const render = (src, size) => new Resvg(src, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

fs.writeFileSync('build-resources/icon.png', render(svg, 512));
fs.writeFileSync('public/icon-192.png', render(svg, 192));

// ICO with embedded PNGs
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => render(svg, s));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, e);
  header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt8(0, e + 2);
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync('build-resources/icon.ico', Buffer.concat([header, ...pngs]));

// Android
const res = 'android/app/src/main/res';
if (fs.existsSync(res)) {
  const inner = svg.match(/<g id="mark">[\s\S]*<\/g>\s*<\/g>/)[0];
  const defs = svg.match(/<defs>[\s\S]*<\/defs>/)[0];
  // adaptive foreground: 108dp canvas, mark scaled into the 66dp safe zone
  const fg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<g transform="translate(256 256) scale(0.62) translate(-256 -256)">${inner}</g></svg>`;
  const round = svg.replace('rx="112"', 'rx="240"');
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, f] of Object.entries(dens)) {
    const dir = path.join(res, `mipmap-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), render(svg, Math.round(48 * f)));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), render(round, Math.round(48 * f)));
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), render(fg, Math.round(108 * f)));
  }
  fs.mkdirSync(path.join(res, 'values'), { recursive: true });
  fs.writeFileSync(
    path.join(res, 'values', 'ic_launcher_background.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#7A3FB8</color>\n</resources>\n',
  );
  // splash: icon centred on the theme colour
  const splash = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200"><rect width="1200" height="1200" fill="#7A3FB8"/>${defs}<g transform="translate(600 600) scale(0.75) translate(-256 -256)">${inner}</g></svg>`;
  for (const dir of fs.readdirSync(res).filter((d) => d.startsWith('drawable'))) {
    const file = path.join(res, dir, 'splash.png');
    if (fs.existsSync(file)) fs.writeFileSync(file, render(splash, 1200));
  }
  console.log('Android icons written');
}
console.log('Icons written');
