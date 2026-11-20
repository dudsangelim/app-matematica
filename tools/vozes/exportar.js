/* Reads, from the game itself, every line the characters have recorded (voiceScript in index.html) and writes it to tools/vozes/falas.json.
   gerar.py then records those lines. Run with: node tools/vozes/exportar.js */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'falas.json');

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(file).pipe(res);
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__ilhaDebug, null, { timeout: 30000 });
    const script = await page.evaluate(() => __ilhaDebug.voiceScript());
    fs.writeFileSync(OUT, JSON.stringify(script, null, 1) + '\n');
    for (const [who, lines] of Object.entries(script)) console.log(`${who.padEnd(8)} ${lines.length} falas`);
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exit(1); });
