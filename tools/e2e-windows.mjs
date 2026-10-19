// End-to-end test of the packaged Windows app against the mock Nextcloud.
// Run on Windows: node tools/e2e-windows.mjs <path-to-NextNote.exe> <profile-dir> <screenshot.png> [test.pdf]
// (needs the mock server: npm run mock-nextcloud)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const [exe, profile, shot] = process.argv.slice(2);
const SERVER = 'http://127.0.0.1:8090';
const auth = 'Basic ' + Buffer.from('alice:secret').toString('base64');

fs.rmSync(profile, { recursive: true, force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, ['--remote-debugging-port=9333', `--user-data-dir=${profile}`], { env, stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
for (let i = 0; i < 160 && !browser; i++) {
  await sleep(500);
  browser = await chromium.connectOverCDP('http://127.0.0.1:9333').catch(() => undefined);
}
if (!browser) throw new Error('App nicht erreichbar');
const ctx = browser.contexts()[0];
let page = ctx.pages()[0];
for (let i = 0; i < 20 && !page; i++) {
  await sleep(300);
  page = ctx.pages()[0];
}
await page.waitForSelector('text=Willkommen bei NextNote');
const result = {};
result.native = await page.evaluate(() => typeof window.nextnoteNative?.http);
await page.getByRole('button', { name: 'App-Passwort' }).click();
await page.getByPlaceholder('https://cloud.example.de').fill(SERVER);
await page.getByLabel('Benutzername').fill('alice');
await page.getByLabel('App-Passwort').fill('secret');
await page.getByRole('button', { name: 'Mit Nextcloud verbinden' }).click();
// empty server: create the first notebook
await page.waitForSelector('.page-title, .welcome-card .btn.primary:not(:disabled)', { timeout: 20000 });
await sleep(800);
if (await page.getByRole('button', { name: 'Erstes Notizbuch anlegen' }).count()) {
  await page.getByRole('button', { name: 'Erstes Notizbuch anlegen' }).click();
}
await page.waitForSelector('.page-title', { timeout: 20000 });
await sleep(1500);
result.notebooks = await page.locator('.notebook-row .nav-label').allTextContents();
result.pages = await page.locator('.page-row-title').allTextContents();
result.texts = await page.locator('.text-container').allTextContents();

// write something on Windows and check it arrives on the server
await page.getByRole('tab', { name: 'Zeichnen' }).click();
await page.getByRole('button', { name: 'Stift' }).first().click();
const box = await page.locator('.page').boundingBox();
await page.mouse.move(box.x + 100, box.y + 260);
await page.mouse.down();
for (let i = 0; i < 30; i++) await page.mouse.move(box.x + 100 + i * 8, box.y + 260 - i * 3);
await page.mouse.up();
await page.keyboard.press('Control+s');
await sleep(4000);
result.syncTitle = await page.locator('.sync-indicator').getAttribute('title');

const list = await fetch(`${SERVER}/remote.php/dav/files/alice/NextNote/Mein%20Notizbuch/pages/`, { method: 'PROPFIND', headers: { Authorization: auth, Depth: '1' } }).then((r) => r.text());
const files = [...list.matchAll(/pages\/([a-z0-9]+)\.json/g)].map((m) => m[1]);
let strokesOnServer = 0;
for (const f of files) {
  const j = await fetch(`${SERVER}/remote.php/dav/files/alice/NextNote/Mein%20Notizbuch/pages/${f}.json`, { headers: { Authorization: auth } }).then((r) => r.json());
  strokesOnServer += j.elements.filter((e) => e.type === 'ink').length;
}
result.strokesOnServer = strokesOnServer;
// clipboard: copy the stroke with the selection toolbar, paste it with a right click on a free spot
await page.keyboard.press('Escape');
await page.getByRole('tab', { name: 'Start' }).click();
await page.mouse.click(box.x + 100 + 15 * 8, box.y + 260 - 15 * 3);
await page.waitForSelector('.sel-toolbar', { timeout: 5000 }).catch(() => {});
await page.locator('.sel-toolbar button[title="Kopieren"]').click();
await page.keyboard.press('Escape');
const inkBefore = await page.locator('.ink-layer path').count();
await page.mouse.click(box.x + 520, box.y + 420, { button: 'right' });
await page.getByRole('menuitem', { name: 'Einfügen' }).click();
await sleep(500);
result.pastedStrokes = (await page.locator('.ink-layer path').count()) - inkBefore;
// text copied in another Windows program -> ribbon button
await page.evaluate(() => window.nextnoteNative.clipboardWriteText('Text aus Windows'));
await page.getByRole('tab', { name: 'Einfügen' }).click();
await page.getByRole('button', { name: /^Einfügen – Lasso/ }).click();
await sleep(500);
result.pastedText = (await page.locator('.text-container').allTextContents()).find((t) => t.includes('Text aus Windows')) ?? null;
const clip = await page.evaluate(() => window.nextnoteNative.clipboardRead());
result.clipboardReadWorks = clip.text === 'Text aus Windows';

// PDF printout (checks the pdf.js worker under the app's CSP)
const pdf = process.argv[5];
if (pdf) {
  await page.getByRole('tab', { name: 'Einfügen' }).click();
  const chooserP = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /PDF als Ausdruck/ }).click();
  const chooser = await chooserP;
  await chooser.setFiles(pdf);
  await page.waitForFunction(() => document.querySelectorAll('.image-el img').length >= 2, null, { timeout: 30000 }).catch(() => {});
  result.pdfImages = await page.locator('.image-el img').count();
}
const secure = JSON.parse(fs.readFileSync(`${profile}/secure.json`, 'utf8'));
result.passwordEncrypted = Object.values(secure).every((v) => String(v).startsWith('enc:'));
await page.screenshot({ path: shot });
await browser.close().catch(() => {});
child.kill();
console.log(JSON.stringify(result, null, 2));
process.exit(0);
