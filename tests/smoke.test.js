/* Smoke tests for Ilha dos Números. Run with: npm test
   They open the real page in a headless browser and check the things that broke (or could silently break) before:
   every game mode starts at every level, the question generators never produce an unanswerable question,
   scoring counts each question once, the layout does not hide buttons on phones, and memory is given back. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const FUZZ = +process.env.FUZZ || 1500;

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

const results = [];
async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false }); console.log(`  FAIL  ${name}\n        ${String(e && e.message || e).split('\n').join('\n        ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const errors = [], foreign = [];

  /* Opens the game in a fresh browser profile, answers the first-run tutorial and turns the narration off (faster rounds). */
  async function open(width, height, { tutorial = true } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
    await page.goto(base);
    await page.waitForFunction(() => window.__ilhaDebug, null, { timeout: 30000 });
    if (tutorial) { await page.fill('#t-in', 'Teste'); await page.click('#t-ok'); await page.evaluate(() => { __ilhaDebug.S().voice = false; }); }
    return page;
  }
  /* Travels to a world and waits for the portal fade to finish. */
  async function enter(page, id) {
    await page.evaluate(id => { const D = __ilhaDebug; if (!D.WORLD || D.WORLD.id !== id) D.enterWorld(D.STM[id]); }, id);
    await page.waitForFunction(id => __ilhaDebug.WORLD && __ilhaDebug.WORLD.id === id && !document.querySelector('#fade').classList.contains('on'), id, { timeout: 5000 });
  }
  const start = (page, id, mi, level) => page.evaluate(([id, mi, level]) => { const D = __ilhaDebug, st = D.STM[id]; D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); if (level) { D.S().st[id] = D.S().st[id] || { level: 1, rounds: 0, first: 0, total: 0, stars: 0 }; D.S().st[id].level = level; } D.startMode(st, st.modes[mi]); return D.CH && D.CH.type; }, [id, mi, level]);
  const STATION_IDS = ['contas', 'ordem', 'vocab', 'n10', 'formas', 'dinheiro', 'n100', 'medidas'];
  /* how many games each station offers (the sums station also has the kart) */
  const MODES = { contas: [0, 1, 2, 3, 4, 5], ordem: [0, 1], vocab: [0, 1], n10: [0, 1], formas: [0, 1], dinheiro: [0, 1], n100: [0, 1], medidas: [0, 1] };

  console.log('Ilha dos Números: smoke tests');
  const page = await open(1024, 768, { tutorial: false });

  await test('first run shows the tutorial and loads nothing from other sites', async () => {
    assert(await page.isVisible('#t-in'), 'the name field of the tutorial is not visible');
    await page.fill('#t-in', 'Teste'); await page.click('#t-ok');
    await page.evaluate(() => { __ilhaDebug.S().voice = false; });
    eq(await page.textContent('#h-name'), 'Teste', 'player name in the top bar');
    eq(foreign, [], 'requests to other origins');
  });

  await test(`question generators: ${FUZZ} questions per generator and level are all answerable`, async () => {
    const bad = await page.evaluate(N => {
      const G = window.__ilha, out = [], note = (k, m, q) => { if (out.length < 12) out.push(`${k}: ${m} :: ${String(q && q.text || JSON.stringify(q)).slice(0, 140)}`); };
      const val = s => { if (/^\d+$/.test(String(s))) return +s; const m = String(s).match(/^(\d+) ([+−]) (\d+)$/); return m ? (m[2] === '+' ? +m[1] + +m[3] : +m[1] - +m[3]) : NaN; };
      for (const L of [1, 2, 3]) for (let i = 0; i < N; i++) {
        for (const g of ['genVocab', 'genN10', 'genMoney', 'genN100', 'genMeasure']) {
          const k = `${g} L${L}`; let q; try { q = G[g](L); } catch (e) { note(k, 'threw ' + e.message); continue; }
          if (/undefined|NaN|null/.test(q.text + (q.hint || '') + (q.explain || ''))) note(k, 'broken text', q);
          if (!q.hint) note(k, 'no hint', q);
          if (q.verb === 'carry') { const pre = Array(q.pre || 0).fill(1); if (new Set(q.solIdx).size !== q.solIdx.length || q.solIdx.some(j => !(j >= 0 && j < q.items.length))) note(k, 'solution indexes', q); else if (!q.check([...pre, ...q.solIdx.map(j => q.items[j].v)])) note(k, 'stored solution is rejected', q); if (q.items.length > 20) note(k, 'too many things on the floor: ' + q.items.length, q); }
          else if (q.multi) { if (!q.check(q.sol) || q.sol.some(j => !(j >= 0 && j < q.opts.length) || q.opts[j].locked)) note(k, 'stored solution is rejected', q); }
          else { if (!(Number.isInteger(q.ans) && q.ans >= 0 && q.ans < q.opts.length)) note(k, 'answer index ' + q.ans, q); if (q.opts.length < 3 && !/balança/.test(q.text)) note(k, 'fewer than 3 options', q); }
        }
        { const q = G.genArith(L); if (q.opts.length !== 3 || new Set(q.opts).size !== 3 || !q.opts.includes(q.ans) || [q.a, q.b, q.ans, ...q.opts].some(v => v < 0) || !/^contas\.(soma|sub)$/.test(q.skill)) note('genArith L' + L, 'options', q); }
        { const q = G.genShootArith(L), ok = q.items.filter(x => x.ok); if (ok.length !== (L < 3 ? 1 : 2) || q.items.length !== (L < 3 ? 5 : 6) || (L < 3 && (val(q.ask) !== q.T || q.items.some(x => !/^\d+$/.test(x.label)))) || ok.some(x => val(x.label) !== q.T) || q.items.some(x => !x.ok && val(x.label) === q.T) || q.items.some(x => isNaN(val(x.label))) || new Set(q.items.map(x => x.label)).size !== q.items.length) note('genShootArith L' + L, 'balloons', q); }
        { const q = G.genBus(L), cap = L === 3 ? 20 : 10; if (q.opts.length !== 3 || new Set(q.opts).size !== 3 || !q.opts.includes(q.ans) || q.opts.some(v => v < 0) || q.a < 1 || q.b < 1 || q.end < 1 || q.a > cap || q.end > cap || q.end !== (q.add ? q.a + q.b : q.a - q.b) || q.ans !== (q.kind === 'chg' ? q.b : q.end) || (q.kind === 'chg' && L < 3) || (L < 3 && q.b > (L === 1 ? 3 : 5)) || !/^contas\.(juntar|tirar|falta)$/.test(q.skill) || /undefined|NaN/.test(q.text + q.eq + q.ask)) note('genBus L' + L, 'bus question', q); }
        { const q = G.genGol(L), cap = L === 3 ? 20 : 10, plus = q.kind === 'add' || q.kind === 'need'; if (q.opts.length !== 3 || new Set(q.opts).size !== 3 || !q.opts.includes(q.ans) || q.opts.some(v => v < 1 || v > cap) || q.a < 1 || q.b < 1 || q.end < 1 || q.a > cap || q.end > cap || q.cap !== cap || q.end !== (plus ? q.a + q.b : q.a - q.b) || q.ans !== (q.kind === 'need' ? q.b : q.end) || (L === 1 && !/^(add|sub)$/.test(q.kind)) || (L === 1 && q.b > 3) || q.skill !== 'contas.' + { add: 'juntar', sub: 'tirar', dif: 'comparar', need: 'falta' }[q.kind] || /undefined|NaN/.test(q.text + q.eq + q.ask)) note('genGol L' + L, 'football question', q); }
        { const q = G.genLine(L); if (q.N !== (L === 1 ? 10 : 20) || q.a < 0 || q.a > q.N || q.ans < 0 || q.ans > q.N || q.b < 1 || q.ans !== (q.add ? q.a + q.b : q.a - q.b) || !/^contas\.(retamais|retamenos)$/.test(q.skill)) note('genLine L' + L, 'number line question', q); }
        { const q = G.genShootShapes(L); if (q.items.length !== 8 || !q.items.some(x => x.ok) || !q.items.some(x => !x.ok)) note('genShootShapes L' + L, 'balloons', q); }
        for (const g of ['genFloorOrder', 'genFloorN100']) { const q = G[g](L); if (q.labels.length !== 9 || !q.ok.some(Boolean) || q.ok.every(Boolean) || new Set(q.labels).size !== 9 || q.labels.some(l => +l < 0)) note(`${g} L${L}`, 'tiles', q); }
        for (const g of ['genShareN10', 'genShareMoney']) { const q = G[g](L); if (!q.check(q.sol.map(ix => ix.map(j => q.items[j].v))) || q.items.length > 17) note(`${g} L${L}`, 'solution or item count ' + q.items.length, q); }
        { const q = G.genBuild(L); if (!q.check(q.sol) || q.sol < 1 || q.sol > 12 || q.supply < q.sol) note('genBuild L' + L, 'stairs', q); }
        { const q = G.genShapeQ(L, null); if (/undefined/.test(q.text) || !q.skill) note('genShapeQ L' + L, 'text', q); }
      }
      return out;
    }, FUZZ);
    assert(!bad.length, bad.join('\n'));
  });

  await test('all 20 game modes start at levels 1, 2 and 3 and run for a moment', async () => {
    eq(await page.evaluate(() => Object.fromEntries(Object.keys(__ilhaDebug.STM).map(id => [id, __ilhaDebug.STM[id].modes.map((m, i) => i)]))), MODES, 'games per station');
    const seen = new Set();
    for (const id of STATION_IDS) {
      await enter(page, id);
      for (const mi of MODES[id]) for (const level of [1, 2, 3]) {
        const before = errors.length, type = await start(page, id, mi, level);
        await page.waitForTimeout(120);
        const st = await page.evaluate(() => { const D = __ilhaDebug; for (let i = 0; i < 20; i++) D.step(1 / 60); return { type: D.CH && D.CH.type, mission: !document.querySelector('#mission').hidden, text: document.querySelector('#m-text').textContent }; });
        assert(st.type === type && type, `${id} mode ${mi} level ${level}: challenge did not start`);
        assert(st.mission && st.text.length > 10 && !/undefined|NaN/.test(st.text), `${id} mode ${mi} level ${level}: mission text is "${st.text}"`);
        assert(errors.length === before, `${id} mode ${mi} level ${level}: ${errors.slice(before).join(' | ')}`);
        seen.add(id + ':' + type);
      }
    }
    eq(seen.size, 19, 'distinct station:mode pairs started');
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('a mode starts through the real buttons (talk to the character, pick the game)', async () => {
    await enter(page, 'n10');
    await page.evaluate(() => { const D = __ilhaDebug, n = D.STM.n10.npcPos; D.closeSheet(); D.P.set(n.x + 1.5, 0, n.z); });
    await page.waitForSelector('#b-act:not([hidden])');
    await page.click('#b-act', { force: true });
    await page.click('.mode[data-i="0"]');
    await page.waitForFunction(() => __ilhaDebug.CH && __ilhaDebug.CH.q && !document.querySelector('#mission').hidden, null, { timeout: 3000 });
  });

  await test('jump question: right answer pays and is recorded once, with its skill', async () => {
    await enter(page, 'n100');
    const r = await page.evaluate(async () => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.n100; let guard = 0;
      do { D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[0]); } while (D.CH.q.verb !== 'jump' && ++guard < 80);
      const t = D.CH.targets[D.CH.q.ans], total = S.st.n100.total, first = S.st.n100.first, coins = S.coins, skill = D.CH.skill, n0 = (S.sk[skill] || { n: 0 }).n;
      D.P.set(t.x, 3, t.z); for (let i = 0; i < 90 && !D.CH.locked; i++) D.step(1 / 60);
      return { verb: D.CH.q.verb, locked: D.CH.locked, dTotal: S.st.n100.total - total, dFirst: S.st.n100.first - first, dCoins: S.coins - coins, skill, dSkill: S.sk[skill] ? S.sk[skill].n - n0 : 0, week: Object.keys(S.wk).length };
    });
    eq([r.verb, r.locked, r.dTotal, r.dFirst, r.dCoins, r.dSkill], ['jump', true, 1, 1, 1, 1], 'verb, locked, total, first, coins (1 for a first-try answer), skill count');
    assert(/^n100\./.test(r.skill) && r.week >= 1, 'skill id or weekly history missing');
  });

  await test('carry question: after two misses the basket shows a correct answer', async () => {
    await enter(page, 'n10');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.n10; let guard = 0; D.S().st.n10.level = 1;
      do { D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[0]); } while (D.CH.q.verb !== 'carry' && ++guard < 200);
      const pad = D.CH.pads.pronto, away = D.L2W(st, -6, -3), walk = p => { D.P.set(p.x, 0, p.z); for (let i = 0; i < 5; i++) D.step(1 / 60); };
      walk(away); walk(pad); const ignored = D.CH.tries === 0; walk(D.CH.items[0]); walk({ x: D.CH.basket.x - 1.9, z: D.CH.basket.z }); walk(away); walk(pad); walk(away); const afterFirst = D.CH.tries; walk(pad);
      return { verb: D.CH.q.verb, ignored, afterFirst, locked: D.CH.locked, ok: D.CH.q.check(D.CH.basket.items.map(o => o.v)), owed: (D.S().sk[D.CH.skill] || {}).w };
    });
    eq(r, { verb: 'carry', ignored: true, afterFirst: 1, locked: true, ok: true, owed: 2 }, 'PRONTO with an empty basket is ignored; then state after two wrong checks');
  });

  await test('obby: two wrong platforms and then the right one count as one question', async () => {
    await enter(page, 'contas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.contas; D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[0]);
      const t0 = S.st.contas.total, f0 = S.st.contas.first, row = D.PLATS.filter(p => p.row === 0), stand = p => { D.P.set(p.cx, .05, p.cz); for (let i = 0; i < 6; i++) D.step(1 / 60); };
      row.filter(p => !p.correct).forEach(stand); stand(row.find(p => p.correct));
      return { total: S.st.contas.total - t0, first: S.st.contas.first - f0, row: D.CH.row };
    });
    eq(r, { total: 1, first: 0, row: 1 }, 'records for one obby question');
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('floor is lava: the "Já sei!" button ends the wait; touching lava costs no heart', async () => {
    await enter(page, 'ordem');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.ordem; D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[1]);
      const C = D.CH, lava = D.L2W(st, 4.85, 1.85); C.phase = 'play';
      D.P.set(lava.x, 0, lava.z); for (let i = 0; i < 4; i++) D.step(1 / 60); const heartsAfterLava = C.hearts; D.playAnim('cheer');
      const good = C.tiles.find(t => t.ok); D.P.set(good.p.cx, 1, good.p.cz); C.phase = 'play'; for (let i = 0; i < 40; i++) D.step(1 / 60);
      const shown = !document.querySelector('#b-sure').hidden, time = C.time; document.querySelector('#b-sure').click(); for (let i = 0; i < 3; i++) D.step(1 / 60);
      return { heartsAfterLava, shown, waited: time > 5, won: C.won === true, hidden: document.querySelector('#b-sure').hidden };
    });
    eq(r, { heartsAfterLava: 3, shown: true, waited: true, won: true, hidden: true }, 'lava round');
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('stars and coins follow first-try answers', async () => {
    const r = await page.evaluate(() => { const f = __ilhaDebug.starsFor; return [f(0, 5), f(1, 5), f(2, 5), f(3, 5), f(4, 5), f(5, 5), f(3, 4), f(4, 4), f(5, 6), f(7, 8), f(6, 8), f(3, 3, true)]; });
    eq(r, [0, 1, 1, 2, 2, 3, 2, 3, 2, 2, 2, 1], 'stars');
  });

  await test('missed skills come back more often than the others', async () => {
    const share = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(); D.record('dinheiro', false, 'dinheiro.vale'); let n = 0;
      for (let i = 0; i < 600; i++) { window.__ilha.genMoney(1); if (__ilhaDebug.lastSkill() === 'dinheiro.vale') n++; }
      return { n, owed: S.sk['dinheiro.vale'].w };
    });
    eq(share.owed, 2, 'answers owed after a miss');
    assert(share.n > 600 * .32, `the missed skill was picked ${share.n} of 600 times (a fair share of 4 types would be 150)`);
  });

  await test('walking stick: it never stays held after the finger is gone', async () => {
    await page.evaluate(() => { const D = __ilhaDebug; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); });
    const fire = (sel, type, id, x, y) => page.evaluate(([sel, type, id, x, y]) => document.querySelector(sel).dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, isPrimary: true, pointerType: 'touch', bubbles: true, button: 0, buttons: 1 })), [sel, type, id, x, y]);
    const held = () => page.evaluate(() => Math.hypot(__ilhaDebug.input.jx, __ilhaDebug.input.jy) > .5);
    const push = async id => { await fire('#touch', 'pointerdown', id, 120, 600); await fire('#touch', 'pointermove', id, 120, 540); assert(await held(), 'the stick did not respond to finger ' + id); };
    await push(11); await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert(!(await held()), 'still walking after the page lost focus');
    await push(12); await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    assert(!(await held()), 'still walking after the page was hidden');
    await push(13); await fire('#b-jump', 'pointerup', 13, 900, 700);
    assert(!(await held()), 'still walking after the release reached another element');
    await push(14); await fire('#touch', 'pointerdown', 15, 130, 610);
    assert(!(await held()), 'a new first finger did not take over a stick whose release was lost');
    await fire('#touch', 'pointermove', 15, 190, 610); assert(await held(), 'the new finger does not drive the stick');
    await fire('#touch', 'pointerup', 15, 190, 610); assert(!(await held()), 'still walking after the new finger was lifted');
    await push(16); await page.evaluate(() => window.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true })));
    assert(!(await held()), 'still walking although no finger is on the screen');
  });

  await test('keyboard: held keys are dropped when the page loses focus or a modifier is released', async () => {
    const walking = () => page.evaluate(() => !!(__ilhaDebug.keys.w || __ilhaDebug.keys.d));
    await page.keyboard.down('w'); assert(await walking(), 'W was not registered');
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); assert(!(await walking()), 'W still held after blur');
    await page.keyboard.up('w'); await page.keyboard.down('d'); await page.keyboard.down('Meta'); await page.keyboard.up('Meta');
    assert(!(await walking()), 'D still held after a modifier key was released'); await page.keyboard.up('d');
  });

  await test('picture quality: every level renders, and "Visual leve" is remembered', async () => {
    const p = await open(900, 700); const before = errors.length;
    const seen = await p.evaluate(async () => { const D = __ilhaDebug, out = []; D.autoQual = false;
      for (const q of [3, 2, 1, 0, 3]) { D.setQuality(q); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const dome = D.scene.children.find(o => o.renderOrder === 10); out.push([D.QUAL, dome.visible, D.renderer.shadowMap.enabled && D.scene.children.some(o => o.isDirectionalLight && o.castShadow)]); }
      return out; });
    eq(seen, [[3, true, true], [2, true, true], [1, false, true], [0, false, false], [3, true, true]], 'level, gradient sky, shadows');
    assert(errors.length === before, errors.slice(before).join(' | '));
    await p.click('#b-menu'); await p.click('#mn-gfx');
    eq(await p.evaluate(() => [__ilhaDebug.S().lite, __ilhaDebug.QUAL]), [true, 0], 'after choosing the light look');
    await p.reload(); await p.waitForFunction(() => window.__ilhaDebug);
    eq(await p.evaluate(() => __ilhaDebug.QUAL), 0, 'level after reopening the game');
    await p.context().close();
  });

  await test('friend riddle in the city can always be closed, also after two wrong answers', async () => {
    const p = await open(1024, 768);
    for (let round = 0; round < 6; round++) {
      await p.evaluate(() => { const D = __ilhaDebug, f = D.FRIENDS[0]; f.cool = 0; D.closeSheet(); D.P.set(f.x + 1.2, 0, f.z); for (let i = 0; i < 3; i++) D.step(1 / 60); });
      await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.waitForSelector('.quiz .btn.big');
      for (let k = 0; k < 2; k++) { const b = await p.$('.quiz .btn.big:not([disabled])'); if (!b) break; await b.click(); }
      await p.waitForSelector('#q-x', { timeout: 3000 }); await p.click('#q-x');
      assert(await p.evaluate(() => document.querySelector('#ov').hidden), 'the sheet did not close');
    }
    await p.context().close();
  });

  await test('floor is lava: a wrong tile at the end of the time costs exactly one heart and the round goes on', async () => {
    await enter(page, 'n100');
    const r = await page.evaluate(async () => {
      const D = __ilhaDebug, st = D.STM.n100; D.timeScale = .01; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[1]);
      const C = D.CH, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }, bad = C.tiles.find(t => !t.ok), good = C.tiles.find(t => t.ok), q0 = C.q;
      C.phase = 'play'; D.P.set(bad.p.cx, 1, bad.p.cz); run(30); C.time = 0; run(2); const afterTime = [C.hearts, C.locked, C.phase];
      D.P.set(good.p.cx, 1, good.p.cz); run(30); const lava = D.L2W(st, 4.85, 1.85); D.P.set(lava.x, 0, lava.z); run(6); const afterLava = C.hearts;
      await new Promise(r => setTimeout(r, 400)); run(2);
      return { afterTime, afterLava, idx: C.idx, moved: C.q !== q0 };
    });
    eq(r, { afterTime: [2, true, 'resolve'], afterLava: 2, idx: 1, moved: true }, 'hearts, lock and phase when the time ends; hearts after touching lava; next question');
    await page.evaluate(() => { __ilhaDebug.timeScale = 1; document.querySelector('#m-quit').click(); });
  });

  await test('shapes hunt: starting again while still touching a shape does not count as an answer', async () => {
    await enter(page, 'formas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.formas, out = []; D.S().st.formas.level = 1;
      for (const sh of D.SHAPES.filter(s => !s.flat)) { D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.P.set(sh.x + sh.r + .5, 0, sh.z); for (let i = 0; i < 5; i++) D.step(1 / 60); D.startMode(st, st.modes[0]); for (let i = 0; i < 20; i++) D.step(1 / 60); out.push(D.CH.tries + D.CH.idx); }
      return out;
    });
    eq(r, r.map(() => 0), 'tries + answered questions right after each restart');
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('painting: walking over tiles does nothing; the button paints, and the colour asked for is part of the answer', async () => {
    await enter(page, 'vocab');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.vocab, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }, press = () => { document.querySelector('#b-sure').click(); run(2); }; let g = 0; D.S().st.vocab.level = 2;
      do { D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[0]); } while (!(D.CH.q.verb === 'paint' && !D.CH.q.multi) && ++g < 300);
      const C = D.CH, q = C.q, wrong = C.targets.find(t => t.i !== q.ans), right = C.targets[q.ans], off = D.L2W(st, -6, -6), stand = t => { D.P.set(off.x, 0, off.z); run(6); D.P.set(t.x, .4, t.z); run(14); };
      const other = C.buckets.find(b => b.k !== q.col), good = C.buckets.find(b => b.k === q.col), named = /PINTE de <span class="pc"/.test(q.text);
      D.P.set(other.x, 0, other.z); run(6); const offer = document.querySelector('#b-sure').textContent; press();
      stand(wrong); run(60); const walkedOver = [C.tries, C.locked];
      stand(right); const label = document.querySelector('#b-sure').textContent; press(); const wrongColour = [C.tries, C.locked];
      D.P.set(good.x, 0, good.z); run(6); press(); stand(right); press();
      return { verb: q.verb, named, offer: offer.includes(other.n), label: label.includes('Pintar'), walkedOver, wrongColour, locked: C.locked, tries: C.tries };
    });
    eq(r, { verb: 'paint', named: true, offer: true, label: true, walkedOver: [0, false], wrongColour: [1, false], locked: true, tries: 1 }, 'paint flow');
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('camera keys Q and R stop turning the camera when released', async () => {
    await page.evaluate(() => __ilhaDebug.closeSheet());
    await page.keyboard.down('q'); await page.waitForTimeout(150); await page.keyboard.up('q'); await page.waitForTimeout(150);
    const a = await page.evaluate(() => __ilhaDebug.yaw); await page.waitForTimeout(500);
    const b = await page.evaluate(() => __ilhaDebug.yaw);
    assert(Math.abs(a - b) < 1e-6, `camera kept turning: ${a} -> ${b}`);
  });

  await test('GPU memory is given back after each question', async () => {
    await enter(page, 'n100');
    const geo = () => page.evaluate(() => __ilhaDebug.renderer.info.memory.geometries);
    const cycle = async n => { for (let i = 0; i < n; i++) { for (const mi of [0, 1]) { await start(page, 'n100', mi, 1 + i % 3); await page.waitForTimeout(60); } } await page.evaluate(() => document.querySelector('#m-quit').click()); await page.waitForTimeout(100); };
    /* warm-up: fixed scenery only counts once it has been drawn, so look all around and play enough questions for every kind of object to have appeared */
    for (let k = 0; k < 8; k++) { await page.evaluate(k => { __ilhaDebug.yaw = k * Math.PI / 4; }, k); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
    await cycle(22); const g0 = await geo(); await cycle(25); const g1 = await geo();
    assert(g1 - g0 <= 6, `geometries grew from ${g0} to ${g1} over 50 questions`);
  });

  await test('finishing a round is scored even if the player starts something else right away', async () => {
    await enter(page, 'formas');
    const out = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.formas; D.closeSheet(); D.startMode(st, st.modes[0]);
      const rounds = S.st.formas.rounds, C = D.CH; C.idx = C.n - 1; const q = C.qs[C.idx], sh = D.SHAPES.find(x => x.n === q.n);
      D.P.set(sh.x + (sh.flat ? 0 : sh.r + .5), 0, sh.z); for (let i = 0; i < 10 && D.CH; i++) D.step(1 / 60);
      const pending = !!D.pendFin; D.startMode(st, st.modes[1]);
      return { pending, scored: S.st.formas.rounds - rounds, sheetHidden: document.querySelector('#ov').hidden, type: D.CH && D.CH.type };
    });
    eq(out, { pending: true, scored: 1, sheetHidden: true, type: 'shoot' }, 'round end race');
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('phone upright (390x844): the mission panel does not cover the top buttons', async () => {
    const p = await open(390, 844); await enter(p, 'n100'); await start(p, 'n100', 0, 1); await p.waitForTimeout(200);
    const r = await p.evaluate(() => { const hit = id => { const b = document.querySelector(id).getBoundingClientRect(), e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && (e.id || e.parentElement.id); };
      const m = document.querySelector('#mission').getBoundingClientRect(), h = document.querySelector('.hud-top').getBoundingClientRect(); return { menu: hit('#b-menu'), voice: hit('#b-voice'), quit: hit('#m-quit'), below: m.top >= h.bottom, wide: m.right <= innerWidth && m.left >= 0 }; });
    eq(r, { menu: 'b-menu', voice: 'b-voice', quit: 'm-quit', below: true, wide: true }, 'what a tap reaches');
    await p.context().close();
  });

  await test('phone sideways (667x375): hints do not land on top of the question', async () => {
    const p = await open(667, 375); await enter(p, 'n100');
    const r = await p.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.n100; let guard = 0;
      do { D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[0]); } while (D.CH.q.verb !== 'jump' && ++guard < 80);
      const t = D.CH.targets.find(t => t.i !== D.CH.q.ans); D.P.set(t.x, 3, t.z); for (let i = 0; i < 90 && !D.CH.tries; i++) D.step(1 / 60);
      const a = document.querySelector('#toast'), m = document.querySelector('#mission').getBoundingClientRect(), b = a.getBoundingClientRect(), j = document.querySelector('#b-jump').getBoundingClientRect();
      const cut = (x, y) => !(x.right <= y.left || x.left >= y.right || x.bottom <= y.top || x.top >= y.bottom);
      return { tries: D.CH.tries, toast: !a.hidden, overMission: cut(b, m), overJump: cut(b, j), missionFits: m.bottom < innerHeight * .5 };
    });
    eq(r, { tries: 1, toast: true, overMission: false, overJump: false, missionFits: true }, 'hint position');
    await p.context().close();
  });

  await test('players: a second player starts from zero and the first one keeps their progress', async () => {
    const p = await open(1024, 768);
    await p.evaluate(() => { const D = __ilhaDebug; D.S().coins = 37; });
    await p.click('#b-menu'); await p.click('#mn-pl'); await Promise.all([p.waitForNavigation(), p.click('.players button[data-id="new"]')]);
    await p.waitForFunction(() => window.__ilhaDebug); assert(await p.isVisible('#t-in'), 'the new player was not asked for a name');
    await p.fill('#t-in', 'Irmã'); await p.click('#t-ok');
    eq(await p.evaluate(() => [__ilhaDebug.S().coins, __ilhaDebug.PF.ids.length]), [0, 2], 'new player coins and player count');
    await p.click('#b-menu'); await p.click('#mn-pl'); await Promise.all([p.waitForNavigation(), p.click('.players button[data-id="0"]')]);
    await p.waitForFunction(() => window.__ilhaDebug);
    eq(await p.evaluate(() => [__ilhaDebug.S().name, __ilhaDebug.S().coins]), ['Teste', 37], 'first player after switching back');
    await p.context().close();
  });

  await test('saves from the previous version still load', async () => {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } }); const p = await ctx.newPage(); p.on('pageerror', e => errors.push(e.message));
    await p.addInitScript(() => { if (!localStorage.getItem('ilha-numeros-3d-v1')) localStorage.setItem('ilha-numeros-3d-v1', JSON.stringify({ name: 'Antigo', coins: 12, stars: 4, sound: true, music: true, voice: false, tut: true, look: { skin: 's1', shirt: 'azul', pants: 'jeans', hat: 'bone', pet: 'nenhum' }, owned: ['hat:bone'], st: { contas: { level: 2, rounds: 3, first: 9, total: 14, stars: 6 } }, trophies: { contas: 2, formas: 3 }, champ: false })); });
    await p.goto(base); await p.waitForFunction(() => window.__ilhaDebug);
    eq(await p.evaluate(() => { const S = __ilhaDebug.S(); return [S.name, S.coins, S.st.contas.level, S.trophies.contas, S.trophies.formas, typeof S.sk, S.edit, S.celes, S.cele, S.misOn && S.restOn && Array.isArray(S.errs) && typeof S.days === 'object' && Object.keys(S.rest).length === 0, document.querySelector('#ov').hidden]; }), ['Antigo', 12, 2, 2, 4, 'object', true, 2, '', true, true], 'old save (its gold cup, stored as 3, becomes 4; the shop pass starts available; one celebration for each station with a medal)');
    await p.click('#b-menu'); await p.click('#mn-par');
    const [a, b] = await p.evaluate(() => document.querySelector('#gate p').textContent.match(/\d+/g).map(Number));
    await p.fill('#g-in', String(a * b)); await p.click('#gate .btn.gold'); await p.waitForSelector('#p-ex');
    assert((await p.textContent('#sheet')).includes('Progresso de Antigo'), 'parents area did not open');
    await ctx.close();
  });

  await test('sharing question: after two misses each friend is shown a correct share', async () => {
    await enter(page, 'dinheiro');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.dinheiro; D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[1]);
      const pad = D.CH.pads.pronto, away = D.L2W(st, -4.8, 0), walk = p => { D.P.set(p.x, 0, p.z); for (let i = 0; i < 5; i++) D.step(1 / 60); };
      walk(away); walk(pad); const ignored = D.CH.tries === 0; walk(D.CH.items[0]); walk(D.CH.friends[0]); walk(away); walk(pad); walk(away); walk(pad);
      return { ignored, tries: D.CH.tries, locked: D.CH.locked, ok: D.CH.q.check(D.CH.friends.map(f => f.items.map(o => o.v))) };
    });
    eq(r, { ignored: true, tries: 2, locked: true, ok: true }, 'PRONTO with nothing delivered is ignored; then state after two wrong checks');
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('a round with nothing right at the first try gives no star, no bonus and no medal', async () => {
    await enter(page, 'formas');
    const before = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.formas; D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); delete S.trophies.formas; D.startMode(st, st.modes[0]);
      const C = D.CH; C.idx = C.n - 1; C.first = 0; C.coins = 0; C.tries = 2; const q = C.qs[C.idx], sh = D.SHAPES.find(x => x.n === q.n), state = { coins: S.coins, stars: S.stars };
      D.P.set(sh.x + (sh.flat ? 0 : sh.r + .5), 0, sh.z); for (let i = 0; i < 10 && D.CH; i++) D.step(1 / 60); return state;
    });
    await page.waitForSelector('.result h2', { timeout: 6000 });
    const after = await page.evaluate(() => { const S = __ilhaDebug.S(); return { title: document.querySelector('.result h2').textContent, coins: S.coins, stars: S.stars, trophy: S.trophies.formas || 0 }; });
    eq([after.title, after.coins - before.coins, after.stars - before.stars, after.trophy], ['Vamos treinar mais!', 0, 0, 0], 'title, coins (none for a late right answer), stars, trophy');
    await page.evaluate(() => __ilhaDebug.closeSheet());
  });

  await test('capital letters option switches the whole interface and is remembered', async () => {
    const p = await open(800, 600);
    await p.click('#b-menu'); await p.click('#mn-caps');
    eq(await p.evaluate(() => [document.body.classList.contains('caps'), getComputedStyle(document.querySelector('#mn-help')).textTransform, __ilhaDebug.S().caps]), [true, 'uppercase', true], 'after switching on');
    await p.reload(); await p.waitForFunction(() => window.__ilhaDebug);
    assert(await p.evaluate(() => document.body.classList.contains('caps')), 'not remembered after reload');
    await p.context().close();
  });

  await test('backup: the saved copy can be restored', async () => {
    const p = await open(900, 700);
    await p.evaluate(() => { const S = __ilhaDebug.S(); S.coins = 41; __ilhaDebug.record('contas', true, 'contas.soma'); });
    const gate = async () => { await p.click('#b-menu'); await p.click('#mn-par'); const [a, b] = await p.evaluate(() => document.querySelector('#gate p').textContent.match(/\d+/g).map(Number)); await p.fill('#g-in', String(a * b)); await p.click('#gate .btn.gold'); await p.waitForSelector('#p-ex'); };
    await gate();
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#p-ex')]);
    const file = await dl.path(), data = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq([data.app, data.save.name, data.save.coins, data.save.sk['contas.soma'].n], ['ilha-dos-numeros', 'Teste', 41, 1], 'backup content');
    await p.evaluate(() => { const S = __ilhaDebug.S(); S.coins = 0; });
    await p.setInputFiles('#p-file', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await p.waitForTimeout(300); eq(await p.evaluate(() => __ilhaDebug.S().coins), 0, 'a foreign file must be refused');
    await Promise.all([p.waitForNavigation(), p.setInputFiles('#p-file', file)]);
    await p.waitForFunction(() => window.__ilhaDebug);
    eq(await p.evaluate(() => [__ilhaDebug.S().coins, __ilhaDebug.S().name]), [41, 'Teste'], 'restored save');
    await p.context().close();
  });

  await test('works offline after the first visit (page, 3D engine and fonts come from the cache)', async () => {
    const p = await open(800, 600);
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.waitForFunction(async () => { const ks = await caches.keys(); if (!ks.length) return false; const c = await caches.open(ks[0]); return (await c.keys()).length >= 13; }, null, { timeout: 15000 });
    await p.context().setOffline(true);
    await p.reload(); await p.waitForFunction(() => window.__ilhaDebug, null, { timeout: 15000 });
    const r = await p.evaluate(async () => { await document.fonts.load('700 40px Fredoka'); return { three: typeof THREE, font: document.fonts.check('700 40px Fredoka'), name: __ilhaDebug.S().name }; });
    eq(r, { three: 'object', font: true, name: 'Teste' }, 'offline boot');
    await p.context().close();
  });

  await test('random play in every mode (walking everywhere, pressing everything) raises no error', async () => {
    const ms = +process.env.SOAK || 2500;
    for (const id of STATION_IDS) {
      await enter(page, id);
      for (const mi of MODES[id]) {
        const before = errors.length; await start(page, id, mi, 1 + Math.floor(Math.random() * 3));
        const until = Date.now() + ms;
        while (Date.now() < until) {
          await page.evaluate(() => { const D = __ilhaDebug; if (!D.CH) return; D.closeSheet();
            const st = D.CH.st, r = (a, b) => a + Math.random() * (b - a), w = D.CH.type === 'obby' ? { x: D.P.x + r(-1, 6), z: r(-5, 5) } : D.L2W(st, r(-5, 13), r(-10, 10));
            D.P.set(w.x, Math.random() < .3 ? 3 : 0, w.z); D.fire(); const b = document.querySelector('#b-sure'); if (!b.hidden && Math.random() < .5) b.click();
            for (let i = 0; i < 12; i++) D.step(1 / 60); });
          await page.waitForTimeout(40);
        }
        assert(errors.length === before, `${id} mode ${mi}: ${errors.slice(before, before + 3).join(' | ')}`);
        await page.evaluate(() => { const D = __ilhaDebug; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); });
      }
    }
  });

  /* Plays one whole round without a single mistake, the way a careful child would, and returns what the result sheet says.
     The waits between questions are sped up (timeScale); everything else is the real game. */
  async function perfectRound(pg, id, mi, level) {
    await enter(pg, id);
    await pg.evaluate(([id, mi, level]) => { const D = __ilhaDebug, st = D.STM[id], S = D.S(); D.timeScale = .01; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click();
      S.st[id] = S.st[id] || { level: 1, rounds: 0, first: 0, total: 0, stars: 0 }; S.st[id].level = level; window.__missed = new Set(); D.startMode(st, st.modes[mi]); }, [id, mi, level]);
    for (let guard = 0; guard < 600; guard++) {
      const done = await pg.evaluate(() => {
        const D = __ilhaDebug, C = D.CH;
        if (!C) return !document.querySelector('#ov').hidden && !!document.querySelector('.result h2');
        const st = C.st, L = (A, B) => D.L2W(st, A, B), run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); };
        const go = (x, z, y) => { D.P.set(x, y || 0, z); run(12); };
        if (C.tries > 0) (window.__missed = window.__missed || new Set()).add(`${C.skill || (C.qs && C.qs[C.idx] && C.qs[C.idx].skill)} (${C.q && C.q.verb || C.type}): ${String(C.q && C.q.text || (C.qs && C.qs[C.idx] && C.qs[C.idx].text) || '').replace(/<[^>]+>/g, '').slice(0, 90)} >> ${document.querySelector('#toast').textContent.slice(0, 70)}`);
        if (C.type === 'build' && C.chest) { go(C.chest.x, C.chest.z, C.chest.y + .2); return false; }
        if (C.locked) return false;
        if (C.type === 'obby') { const pl = D.PLATS.find(x => x.row === C.row && x.correct); go(pl.cx, pl.cz, .05); }
        else if (C.type === 'order') { const q = C.cubes.find(q => !q.taken && q.n === C.seq[C.idx]); go(q.x, q.z); }
        else if (C.type === 'shapes') { const q = C.qs[C.idx], sh = D.SHAPES.find(x => x.n === q.n); go(st.spawn.x, st.spawn.z); go(sh.x + (sh.flat ? 0 : sh.r + .5), sh.z); }
        else if (C.type === 'shoot') { const b = C.balloons.find(b => b.alive && b.it.ok); if (b) { const p = b.sp.position, dx = p.x - D.P.x, dz = p.z - D.P.z, dy = p.y - (D.P.y + D.SCOPE.eye); let a = Math.atan2(dx, dz) - C.a0; a = Math.atan2(Math.sin(a), Math.cos(a)); C.ax = a; C.ay = Math.atan2(dy, Math.hypot(dx, dz)) + .05; run(2); if (D.aim() === b) { D.fire(); for (let i = 0; i < 90 && b.alive; i++) D.step(1 / 60); } } }
        else if (C.type === 'floor') { if (C.phase === 'read') C.phase = 'play'; if (C.phase !== 'play') return false; const t = C.tiles.find(t => t.ok); go(t.p.cx, t.p.cz, 1); run(20); document.querySelector('#b-sure').click(); run(3); }
        else if (C.type === 'bus') { if (C.ph !== 'ask') { run(30); return false; } run(2); document.querySelectorAll('#picks .pk')[C.q.opts.indexOf(C.q.ans)].click(); run(4); }
        else if (C.type === 'gol') { if (C.ph !== 'ask') { run(30); return false; } run(2); document.querySelectorAll('#picks .pk')[C.q.opts.indexOf(C.q.ans)].click(); run(60); }
        else if (C.type === 'line') { if (C.hop) { const n = Math.abs(C.q.ans - C.pos); for (let i = 0; i < n; i++) { D.jump(); run(24); } } else go(st.c.x + C.B0 + C.q.ans * C.w, st.c.z - C.fixCam.x); run(3); document.querySelector('#b-sure').click(); run(3); }
        else if (C.type === 'kart') { if (C.phase === 'ready') C.phase = 'go'; const g = C.gates[C.idx]; C.v = 8; if (g) C.lat = (C.qs[C.idx].ans - 1) * 4; D.P.x = (g ? g.x : C.endX) - .3; run(6); }
        else if (C.type === 'simon') { if (C.phase === 'read') C.phase = 'play'; if (C.phase !== 'play') return false; const q = C.q, s = q.steps[C.si], idx = C.si, press = () => { const bt = document.querySelector('#b-sure'); if (!bt.hidden) bt.click(); };
          const spot = { dentro: [11, 7], embaixo: [2, -6], perto: [10, -5.5], longe: [-4, 11.5], entre: [2, 8] }, live = () => D.CH === C && C.q === q && C.si === idx && !C.locked;
          if (q.trick) { run(60 * 7); }
          else if (s.k === 'go' || s.k === 'bring' || (s.k === 'carry' && C.hold)) { if (s.pk === 'cima') { const pl = D.PLATS.find(p => p.bloco); go(pl.cx, pl.cz, 1.3); } else { const w = L(spot[s.pk][0], spot[s.pk][1]); go(w.x, w.z); } run(40); }
          else if (s.k === 'jump') { run(2); for (let i = 0; i < s.n && live(); i++) { D.jump(); run(60); } }
          else if (s.k === 'color') { const m = C.mats.find(m => m.k === s.c); go(m.x, m.z); run(30); }
          else if (s.k === 'ring') { go(C.bell.x + 1.2, C.bell.z); for (let i = 0; i < s.n; i++) { run(3); press(); } run(3); }
          else if (s.k === 'around') { const o = L(s.o.p[0], s.o.p[1]), R = s.o.r0 + 1.6; for (let k = 0; k <= 46 && live(); k++) { const a = k / 40 * 2 * Math.PI; D.P.set(o.x + Math.cos(a) * R, 0, o.z + Math.sin(a) * R); D.step(1 / 60); } }
          else if (s.k === 'take' || s.k === 'carry') { const it = C.items.find(o => o.k === s.it); go(it.x + .8, it.z); press(); run(3); }
          else if (s.k === 'tag' || s.k === 'seek') { const f = C.kids.find(f => f.c === s.c); for (let i = 0; i < 30 && live(); i++) { D.P.set(f.x, 0, f.z); D.step(1 / 60); } }
          else if (s.k === 'hide') { const h = D.SM.hides.find(h => h.w === s.w), o = L(h.A, h.B), dx = o.x - C.master.x, dz = o.z - C.master.z, d = Math.hypot(dx, dz); go(o.x + dx / d * (h.r + 1.3), o.z + dz / d * (h.r + 1.3)); for (let i = 0; i < 60 * 8 && live(); i++) D.step(1 / 60); }
          else if (s.k === 'flee') { for (let i = 0; i < 60 * 9 && live(); i++) { const f = C.kids.find(f => f.chase); if (f && i % 20 === 0) { const w = L(f.x > st.c.x + 5 ? -3 : 13, f.z > st.c.z ? -10 : 10); D.P.set(w.x, 0, w.z); } D.step(1 / 60); } }
          else if (s.k === 'statue') { for (let i = 0; i < 60 * 5 && live(); i++) D.step(1 / 60); } }
        else if (C.type === 'share') { C.q.sol.forEach((ix, i) => { ix.forEach(j => { const o = C.items[j]; go(o.x, o.z); }); const f = C.friends[i]; go(f.x, f.z); }); const a = L(-6, 0); go(a.x, a.z); go(C.pads.pronto.x, C.pads.pronto.z); }
        else if (C.type === 'build') { let need = C.q.sol - C.steps.length; for (const o of C.items) { if (need <= 0) break; if (o.state === 'ground') { go(o.x, o.z); need--; } } const a = L(-6, 6); go(a.x, a.z); go(C.pads.put.x, C.pads.put.z); go(a.x, a.z); go(C.pads.pronto.x, C.pads.pronto.z); }
        else if (C.type === 'act') { const q = C.q, off = L(-6, -6);
          if (q.verb === 'jump') { const t = C.targets[q.ans]; D.P.set(t.x, 1.4, t.z); for (let i = 0; i < 60 && !C.locked; i++) D.step(1 / 60); }
          else if (q.verb === 'circle') { const t = C.targets[q.ans]; for (let k = 0; k <= 48 && !C.locked; k++) { const a = k / 40 * 2 * Math.PI; D.P.set(t.x + Math.cos(a) * t.R, 0, t.z + Math.sin(a) * t.R); D.step(1 / 60); } }
          else if (q.verb === 'paint') { const press = () => { document.querySelector('#b-sure').click(); run(2); }, take = k => { const bk = C.buckets.find(b => b.k === k); go(bk.x, bk.z); press(); };
            const jobs = (q.multi ? q.sol : [q.ans]).map((i, n) => [i, q.cols ? q.solCol[n] : q.col]); let have = null;
            for (const [i, k] of jobs) { if (have !== k) { take(k); have = k; } const t = C.targets.find(t => t.i === i); go(off.x, off.z); go(t.x, t.z, .4); press(); }
            if (q.multi) { go(off.x, off.z); go(C.pads.pronto.x, C.pads.pronto.z); } }
          else if (q.verb === 'smash') { const t = C.targets[q.ans]; go(t.x - 2, t.z); document.querySelector('#b-sure').click(); }
          else if (q.verb === 'kick') { const t = C.targets[q.ans], b = C.ball, g = L(t.A + .6, t.B), d = Math.hypot(g.x - b.x, g.z - b.z); if (b.wait || Math.hypot(b.vx, b.vz) > .1) return false; go(b.x - (g.x - b.x) / d * 1.4, b.z - (g.z - b.z) / d * 1.4); document.querySelector('#b-sure').click(); for (let i = 0; i < 90 && !C.locked; i++) D.step(1 / 60); }
          else if (q.verb === 'throw') { if (C.shot) { run(60); return false; } const t = C.targets[q.ans], s0 = L(-1, 0); D.P.set(s0.x, 0, s0.z); D.rotY = Math.atan2(t.x - s0.x, t.z - s0.z); run(3); D.rotY = Math.atan2(t.x - s0.x, t.z - s0.z); document.querySelector('#b-sure').click(); for (let i = 0; i < 90 && !C.locked; i++) D.step(1 / 60); }
          else { q.solIdx.forEach((i, k) => { const o = C.items[i]; go(o.x, o.z); if (q.one || k % 8 === 7) go(C.basket.x - 1.9, C.basket.z); }); go(C.basket.x - 1.9, C.basket.z); go(off.x, off.z + 12); go(C.pads.pronto.x, C.pads.pronto.z); } }
        return false;
      });
      if (done) break;
      await pg.waitForTimeout(25);
    }
    return pg.evaluate(id => { const S = __ilhaDebug.S(), h = document.querySelector('.result h2'); if (!h) return { error: 'the round never reached the result sheet', type: __ilhaDebug.CH && __ilhaDebug.CH.type, skill: __ilhaDebug.CH && __ilhaDebug.CH.skill, tries: __ilhaDebug.CH && __ilhaDebug.CH.tries };
      const out = { missed: [...(window.__missed || [])], won: document.querySelectorAll('.result p')[1].textContent, stars: document.querySelectorAll('.bigstars span:not(.off)').length, line: document.querySelector('.result p').textContent, level: S.st[id].level, trophy: S.trophies[id] || 0 }; __ilhaDebug.closeSheet(); return out; }, id);
  }

  await test('a round played without mistakes earns 3 stars in every game mode, at every level', async () => {
    const p = await open(1024, 768); const bad = [];
    await p.evaluate(() => { __ilhaDebug.autoQual = false; __ilhaDebug.setQuality(0); });
    for (const id of STATION_IDS) for (const mi of MODES[id]) {
      const isAct = await p.evaluate(([id, mi]) => __ilhaDebug.STM[id].modes[mi].k === 'act', [id, mi]);
      for (const level of [1, 2, 3]) for (let rep = 0; rep < (isAct ? 3 : 1); rep++) {
        const r = await perfectRound(p, id, mi, level);
        const n = +(/acertou (\d+) de/.exec(r.line || '') || [])[1], won = /Ganhou (\d+) 🪙 \(com o bônus de 3\)/.exec(r.won || '');
        if (r.error || r.stars !== 3 || !/acertou (\d+) de \1 /.test(r.line) || !won || +won[1] < n + 3 || +won[1] > 2 * n + 3) bad.push(`${id} mode ${mi} level ${level}: ${JSON.stringify(r)}`);
      }
    }
    assert(!bad.length, bad.join('\n'));
    const t = await p.evaluate(() => __ilhaDebug.S().trophies);
    eq(STATION_IDS.map(id => t[id]), STATION_IDS.map(() => 4), 'gold cup in every station after perfect level-3 rounds');
    assert(await p.evaluate(() => __ilhaDebug.S().champ), 'the champions cup was not awarded with all 8 gold cups');
    await p.context().close();
  });

  await test('medals: a perfect round gives the gold medal, and gold at level 3 gives the cup', async () => {
    const p = await open(1024, 768);
    await p.evaluate(() => { __ilhaDebug.autoQual = false; __ilhaDebug.setQuality(0); });
    const seen = [];
    for (const level of [1, 2, 3]) { const r = await perfectRound(p, 'n10', 0, level); seen.push([r.stars, r.level, r.trophy]); }
    eq(seen, [[3, 2, 3], [3, 3, 3], [3, 3, 4]], 'stars, level reached and best medal (3 = gold medal, 4 = gold cup) after each perfect round in Fazenda do 10');
    await p.context().close();
  });

  await test('mission panel folds away, keeps the clock visible, and peeks on a new question', async () => {
    const p = await open(1024, 768); await enter(p, 'ordem'); await start(p, 'ordem', 1, 1); await p.waitForTimeout(150);
    const box = () => p.evaluate(() => { const m = document.querySelector('#mission').getBoundingClientRect(); return { w: Math.round(m.width), h: Math.round(m.height), min: document.querySelector('#mission').classList.contains('min') }; });
    const open0 = await box(); await p.click('#m-min'); const folded = await box();
    assert(folded.min && folded.w < open0.w * .7 && folded.h <= 52, `folded panel is ${folded.w}x${folded.h}, open was ${open0.w}x${open0.h}`);
    const vis = await p.evaluate(() => { const v = s => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().width > 0; }; return [v('#m-text .vt'), v('#m-text small.live'), v('#m-quit'), v('#m-spk'), __ilhaDebug.S().misMin]; });
    eq(vis, [true, true, true, true, true], 'tag, clock and hearts, quit, listen, saved preference');
    await p.evaluate(() => { const D = __ilhaDebug; D.CH.phase = 'play'; D.CH.time = 9; }); await p.waitForTimeout(1200);
    assert((await box()).min, 'the clock ticking must not reopen a folded panel');
    await start(p, 'ordem', 0, 1); await p.waitForTimeout(150);
    assert(!(await box()).min, 'a new question should open the folded panel for a moment');
    await p.click('#m-text'); assert((await box()).min, 'a tap on the text did not fold the panel');
    await p.click('#m-min'); eq([(await box()).min, await p.evaluate(() => __ilhaDebug.S().misMin)], [false, false], 'after opening again');
    await p.context().close();
  });

  await test('folded mission panel stays inside a narrow phone screen in a timed game', async () => {
    const p = await open(360, 740); await enter(p, 'vocab'); await start(p, 'vocab', 1, 1); await p.waitForTimeout(150);
    await p.evaluate(() => { const D = __ilhaDebug; D.CH.phase = 'play'; D.CH.time = 12; }); await p.waitForTimeout(1200); await p.click('#m-min');
    const r = await p.evaluate(() => { const box = s => document.querySelector(s).getBoundingClientRect(), m = box('#mission'), q = box('#m-quit'), hit = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2); return { left: m.left >= 0, right: m.right <= innerWidth, quitInside: q.right <= innerWidth && q.left >= 0, quitReachable: hit && hit.id === 'm-quit', clock: box('#m-text small.live').width > 0 }; });
    eq(r, { left: true, right: true, quitInside: true, quitReachable: true, clock: true }, 'folded panel at 360 px wide');
    await p.context().close();
  });

  await test('hammer, football and basket: a wrong pick gives a hint, the right one ends the question', async () => {
    await enter(page, 'dinheiro');
    for (const verb of ['smash', 'kick', 'throw']) {
      const r = await page.evaluate(async verb => {
        const D = __ilhaDebug, st = D.STM.dinheiro, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }, press = () => document.querySelector('#b-sure').click(); let g = 0; D.forceVerb = verb; D.timeScale = .01; D.S().st.dinheiro.level = 2;
        do { D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[0]); } while (D.CH.q.verb !== verb && ++g < 300);
        const C = D.CH, q = C.q, wait = ms => new Promise(r => setTimeout(r, ms)), label = () => document.querySelector('#b-sure').textContent;
        const tryOn = async t => {
          if (verb === 'smash') { D.P.set(t.x - 2, 0, t.z); run(6); const l = label(); press(); await wait(260); run(2); return l; }
          if (verb === 'kick') { const b = C.ball, w = D.L2W(st, t.A + .6, t.B), d = Math.hypot(w.x - b.x, w.z - b.z); D.P.set(b.x - (w.x - b.x) / d * 1.4, 0, b.z - (w.z - b.z) / d * 1.4); run(6); const l = label(); press(); for (let i = 0; i < 90 && Math.hypot(b.vx, b.vz) > 0; i++) D.step(1 / 60); await wait(60); run(2); return l; }
          const s0 = D.L2W(st, -1, 0); D.P.set(s0.x, 0, s0.z); D.rotY = Math.atan2(t.x - s0.x, t.z - s0.z); run(3); const l = label(), aim = C.aim.visible; press(); run(70); return l + (aim ? ' aim' : '');
        };
        const bad = C.targets.find(t => t.i !== q.ans), l1 = await tryOn(bad), afterWrong = [C.tries, C.locked, bad.dead]; D.timeScale = 1; const l2 = await tryOn(C.targets[q.ans]);
        const out = { verb: q.verb, text: /QUEBRE a caixa|CHUTE a bola no gol|ARREMESSE a bola na cesta/.test(q.text), label: l1, afterWrong, locked: C.locked, tries: C.tries, first: C.first }; D.forceVerb = null; D.timeScale = 1; return out;
      }, verb);
      eq([r.verb, r.text, r.afterWrong, r.locked, r.tries, r.first], [verb, true, [1, false, true], true, 1, 0], `${verb} (button "${r.label}")`);
      assert(/Quebrar|Chutar|Arremessar/.test(r.label), `the action button for ${verb} was "${r.label}"`);
    }
    await page.evaluate(() => document.querySelector('#m-quit').click());
  });

  await test('kart: wrong and right gates are scored once each, and the race ends back on the island', async () => {
    await enter(page, 'contas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.contas, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }; D.timeScale = .01; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click();
      const t0 = S.st.contas ? S.st.contas.total : 0, c0 = S.coins; D.startMode(st, st.modes[2]); const C = D.CH, far = Math.hypot(D.P.x - st.c.x, D.P.z - st.c.z) > 100, stays = (run(30), D.P.x);
      document.querySelector('#b-menu').click(); document.querySelector('#mn-x').click(); D.S().name = 'Outro'; const before = C.kart.parent; D.buildPlayer(); const kartKept = !!C.kart.parent && C.kart.parent !== before;
      C.phase = 'go'; const pass = lane => { const g = C.gates[C.idx]; C.v = 8; C.lat = (lane - 1) * 4; D.P.x = g.x - .3; run(6); };
      const q0 = C.qs[0]; pass((q0.ans + 1) % 3); const afterWrong = [C.idx, C.first, S.coins - c0]; pass(C.qs[1].ans); const afterRight = [C.idx, C.first, S.coins - c0];
      for (let k = 2; k < 5; k++) pass(C.qs[k].ans); C.v = 8; D.P.x = C.endX - .3; run(6);
      return { kartKept, far, waitsForStart: Math.abs(stays - (C.x0 + 8)) < .01, afterWrong, afterRight, records: S.st.contas.total - t0, ended: !D.CH, home: Math.hypot(D.P.x - st.c.x, D.P.z - st.c.z) < 20 };
    });
    eq(r, { kartKept: true, far: true, waitsForStart: true, afterWrong: [1, 0, 0], afterRight: [2, 1, 1], records: 5, ended: true, home: true }, 'kart race');
    await page.waitForSelector('.result h2', { timeout: 6000 });
    eq(await page.evaluate(() => document.querySelector('.result p').textContent), 'Kart das Contas: acertou 4 de 5 de primeira.', 'result line');
    await page.evaluate(() => { __ilhaDebug.timeScale = 1; __ilhaDebug.closeSheet(); });
  });

  await test('shop: a football shirt can be bought and worn, and its shorts come with it', async () => {
    const p = await open(1024, 768);
    await p.evaluate(() => { const D = __ilhaDebug; D.S().coins = 100; D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); });
    await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.click('.tab[data-t="kit"]');
    eq(await p.evaluate(() => [document.querySelectorAll('.item').length, document.querySelectorAll('.item img.jr').length]), [27, 27], 'shirts on offer, each with its picture');
    await p.click('.item[data-k="bra"]'); await p.waitForSelector('.quiz .btn.big'); await p.click('.quiz .btn.big[data-v="20"]');
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(); let chest = null; D.scene.traverse(o => { if (o.isMesh && Array.isArray(o.material) && o.material[5] && o.material[5].map && !o.userData.head) chest = o; });
      return { coins: S.coins, shirt: S.look.shirt, owned: S.owned.includes('kit:bra'), chest: !!chest, using: document.querySelector('.item[data-k="bra"]').classList.contains('eq') }; });
    eq(r, { coins: 20, shirt: 'bra', owned: true, chest: true, using: true }, 'after buying the Brasil shirt for 80 with 100 coins');
    await p.context().close();
  });

  await test('football game: the goals are balls on the scoreboard, a button kicks at a number, the goalkeeper saves a wrong one and the board counts, and levels 2 and 3 compare and ask what is missing', async () => {
    await enter(page, 'contas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.contas, mi = st.modes.findIndex(m => m.k === 'gol'), run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }, out = {}, quit = () => { D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); };
      const play = (L, want) => { let g = 0; do { quit(); S.st.contas = S.st.contas || { level: 1, rounds: 0, first: 0, total: 0, stars: 0 }; S.st.contas.level = L; D.startMode(st, st.modes[mi]); } while (want && !want(D.CH.q) && ++g < 400); return D.CH; };
      const toAsk = C => { const seen = { cover: false, max: 0 }; for (let i = 0; i < 1500 && C.ph !== 'ask'; i++) { D.step(1 / 60); if (C.ph === 'move') seen.cover = C.bd.cover; seen.max = Math.max(seen.max, C.bd.n1); } run(3); return seen; };
      const btns = () => [...document.querySelectorAll('#picks .pk')], btn = v => btns().find(b => +b.textContent === v), kick = (C, v) => { btn(v).click(); for (let i = 0; i < 400 && (C.ph === 'kick' || C.ph === 'back'); i++) D.step(1 / 60); run(3); };
      /* level 1, joining: the balls of the two halves stay in sight; no numbers in the goal and no buttons before the question */
      let C = play(1, q => q.kind === 'add'), q = C.q, e0 = (S.errs || []).length; run(10); const p0 = [D.P.x, D.P.z]; D.input.jx = 1; D.jump(); run(20); D.input.jx = 0;
      out.start = [C.type, C.still, document.body.classList.contains('still'), Math.hypot(D.P.x - p0[0], D.P.z - p0[1]) < .01, document.querySelector('#picks').hidden, C.tg.some(s => s.visible), !!C.fixCam];
      let seen = toAsk(C);
      out.l1 = [seen.cover, seen.max === q.a, C.bd.n1 === q.a, C.bd.n2 === q.b, C.bd.cover, btns().map(b => b.textContent).join() === q.opts.join(), C.tg.every(s => s.visible), q.opts.length];
      /* a wrong number: the goalkeeper holds the ball, the button is spent, the board counts every ball, and the question goes on */
      const wrong = q.opts.find(v => v !== q.ans); btn(wrong).click(); out.busy = C.ph; btn(q.ans).click(); out.busy2 = C.ph; /* no second kick while the ball is in the air */
      for (let i = 0; i < 400 && (C.ph === 'kick' || C.ph === 'back'); i++) D.step(1 / 60); run(80);
      out.miss = [C.ph, C.tries, C.defs, C.gols, C.locked, btn(wrong).disabled, btn(wrong).classList.contains('no'), C.tg[q.opts.indexOf(wrong)].visible, (S.errs || []).length - e0, S.errs[S.errs.length - 1].q === q.ask && S.errs[S.errs.length - 1].g === wrong, C.bd.hi > 0, Math.abs(C.ball.position.z - C.bz0) < .01 && Math.abs(C.kp.rotation.x) < .01];
      for (let i = 0; i < 600 && C.count; i++) D.step(1 / 60); out.counted = C.bd.hi === q.ans;
      const f0 = C.first; kick(C, q.ans); run(25); out.goal = [C.ph, C.gols, C.locked, C.first - f0, btn(q.ans).classList.contains('ok'), btns().every(b => b.disabled), C.ball.position.x > 13.5, C.bd.head === q.eq];
      /* right at the first try counts as a first-try answer, and the goalkeeper dives away from the ball */
      C = play(1, q => q.kind === 'sub'); q = C.q; seen = toAsk(C); out.sub = [seen.max === q.a, C.bd.gone === q.b, C.bd.x]; const f1 = C.first, i1 = q.opts.indexOf(q.ans); kick(C, q.ans);
      out.first = [C.first - f1, C.gols, C.defs, Math.sign(C.kick.dz) !== Math.sign([-3, 0, 3][i1]) || i1 === 1];
      /* level 2: the board is dark while the goals change, and a miss lights it; two misses end the question with a save */
      C = play(2, q => q.kind === 'add'); q = C.q; seen = toAsk(C); out.l2 = [seen.cover, C.bd.cover, C.bd.n2 === q.b];
      kick(C, q.opts.find(v => v !== q.ans)); out.l2miss = [C.bd.cover, C.tries, C.ph]; kick(C, q.opts.find(v => v !== q.ans && !btn(v).disabled)); out.l2fail = [C.locked, C.ph, C.defs, btn(q.ans).classList.contains('ok')];
      /* level 2: comparing shows two rows; missing shows the places to fill */
      C = play(2, q => q.kind === 'dif'); q = C.q; toAsk(C); out.dif = [C.bd.n1 === q.a, C.bd.n2 === q.b, q.ans === q.a - q.b, C.bd.num, q.skill];
      C = play(2, q => q.kind === 'need'); q = C.q; toAsk(C); out.need = [q.ans === q.b, q.end === q.a + q.b, C.bd.num, q.skill];
      /* level 3: comparing shows only numbers until a miss */
      C = play(3, q => q.kind === 'dif'); q = C.q; toAsk(C); out.l3 = [C.bd.num, q.cap]; kick(C, q.opts.find(v => v !== q.ans)); out.l3miss = [C.bd.num, !!C.count || C.bd.hi > 0];
      quit(); out.after = [D.CH === null, document.querySelector('#picks').hidden, document.querySelectorAll('#picks .pk').length];
      return out;
    });
    eq(r, { start: ['gol', true, true, true, true, false, true], l1: [false, true, true, true, false, true, true, 3], busy: 'kick', busy2: 'kick', miss: ['ask', 1, 1, 0, false, true, true, false, 1, true, true, true], counted: true,
      goal: ['goal', 1, true, 0, true, true, true, true], sub: [true, true, 0], first: [1, 1, 0, true], l2: [true, true, true], l2miss: [false, 1, 'ask'], l2fail: [true, 'saved', 2, true],
      dif: [true, true, true, false, 'contas.comparar'], need: [true, true, false, 'contas.falta'], l3: [true, 20], l3miss: [false, true], after: [true, true, 0] }, 'football game');
  });

  await test('bus game: people get on and off in sight, the curtains hide them from level 2, the answer is a button on the screen, a miss brings help, and level 3 can ask how many got on', async () => {
    await enter(page, 'contas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.contas, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }, out = {}, quit = () => { D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); };
      const play = (L, want) => { let g = 0; do { quit(); S.st.contas = S.st.contas || { level: 1, rounds: 0, first: 0, total: 0, stars: 0 }; S.st.contas.level = L; D.startMode(st, st.modes[3]); } while (want && !want(D.CH.q) && ++g < 300); return D.CH; };
      const toAsk = C => { const seen = { a: C.seated.length, closedAtMove: null }; for (let i = 0; i < 1500 && C.ph !== 'ask'; i++) { D.step(1 / 60); if (C.ph === 'move' && seen.closedAtMove === null) seen.closedAtMove = C.closed; } run(3); return seen; };
      const btns = () => [...document.querySelectorAll('#picks .pk')], btn = v => btns().find(b => +b.textContent === v), step = (C, v) => { btn(v).click(); run(4); };
      /* level 1, adding: everybody in sight; the player waits at the stop and cannot walk; no buttons before the question */
      let C = play(1, q => q.add && q.kind === 'res'), q = C.q, e0 = (S.errs || []).length; run(20); const p0 = [D.P.x, D.P.z]; D.input.jx = 1; D.input.jy = -1; D.jump(); run(40); D.input.jx = D.input.jy = 0;
      out.still = [C.still, document.body.classList.contains('still'), Math.hypot(D.P.x - p0[0], D.P.z - p0[1]) < .01, D.P.y < .01, document.querySelector('#picks').hidden, getComputedStyle(document.querySelector('#b-jump')).display];
      /* the wrong button counts the people, the right one ends the question */
      let seen = toAsk(C);
      out.l1 = [C.type, seen.a === q.a, seen.closedAtMove, C.seated.length === q.end, C.wait.length === q.b, btns().map(b => b.textContent).join() === q.opts.join() && !document.querySelector('#picks').hidden, C.closed, !!C.fixCam, document.body.classList.contains('fix')];
      const wrong = q.opts.find(v => v !== q.ans); step(C, wrong); out.miss = [C.tries, C.locked, !!C.count, (S.errs || []).length - e0, S.errs[S.errs.length - 1].q === q.ask && S.errs[S.errs.length - 1].g === wrong];
      out.missBtn = [btn(wrong).disabled, btn(wrong).classList.contains('no'), btns().filter(b => b.disabled).length]; step(C, wrong); out.missTwice = C.tries; /* a button already tried does nothing more */
      const f0 = C.first; step(C, q.ans); out.right = [C.locked, C.first - f0, C.ph]; out.rightBtn = [btn(q.ans).classList.contains('ok'), btns().every(b => b.disabled)]; /* right at the second try: it ends the question, but it is not a first-try answer */
      /* level 1, taking away: those who got off stand at the stop */
      C = play(1, q => !q.add); q = C.q; toAsk(C); out.sub = [C.seated.length === q.end, C.gone.length === q.b];
      /* level 2: the curtains are shut while people move, and stay shut for the question; a miss opens them */
      C = play(2, q => q.add); q = C.q; seen = toAsk(C); out.l2 = [seen.closedAtMove, C.closed, C.seated.length === q.end]; step(C, q.opts.find(v => v !== q.ans)); out.l2miss = [C.closed, C.tries];
      step(C, q.opts.find(v => v !== q.ans && !btn(v).disabled)); out.l2fail = [C.locked, C.ph, btn(q.ans).classList.contains('ok')]; /* after two misses the right button is shown */
      /* level 3: two decks, and sometimes the question is how many got on or off */
      C = play(3, q => q.kind === 'chg'); q = C.q; toAsk(C); out.l3 = [C.seated.length === q.end, q.ans === q.b, C.closed, C.bus.userData.cur.length];
      const f1 = C.first; step(C, q.ans); out.l3right = [C.locked, C.first - f1];
      quit(); out.after = [document.body.classList.contains('fix'), D.CH === null, document.querySelector('#picks').hidden, document.querySelectorAll('#picks .pk').length];
      return out;
    });
    eq(r, { still: [true, true, true, true, true, 'none'], l1: ['bus', true, false, true, true, true, false, true, true], miss: [1, false, true, 1, true], missBtn: [true, true, 1], missTwice: 1, right: [true, 0, 'out'], rightBtn: [true, true], sub: [true, true], l2: [true, true, true], l2miss: [false, 1], l2fail: [true, 'out', true], l3: [true, true, false, 2], l3right: [true, 1], after: [true, true, true, 0] }, 'bus game');
    eq(await page.evaluate(() => { __ilhaDebug.step(1 / 60); return [document.body.classList.contains('fix'), document.body.classList.contains('still')]; }), [false, false], 'the still camera and the still player let go when the game ends');
  });

  await test('number line: each press is one hop, the stick can undo a hop, "Cheguei!" checks where the player stopped, and level 3 is walked', async () => {
    await enter(page, 'contas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.contas, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }, out = {}, quit = () => { D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); }, sure = document.querySelector('#b-sure');
      const play = (L, want) => { let g = 0; do { quit(); S.st.contas.level = L; D.startMode(st, st.modes[4]); } while (want && !want(D.CH.q) && ++g < 300); run(3); return D.CH; };
      const hop = n => { for (let i = 0; i < n; i++) { D.jump(); run(24); } };
      let C = play(1, q => q.add && q.b >= 2 && q.ans < q.N), q = C.q;
      out.start = [C.type, C.pos === q.a, !!C.hop, sure.hidden, C.tiles.length, Math.abs(D.P.x - (st.c.x + C.B0 + q.a * C.w)) < .01];
      const p0 = D.P.x; D.input.jy = -1; run(20); D.input.jy = 0; out.noWalk = Math.abs(D.P.x - p0) < .01 && D.P.z === st.c.z - C.fixCam.x;
      hop(q.b + 1); out.over = [C.pos === q.ans + 1, !sure.hidden]; D.input.jx = -1; run(24); D.input.jx = 0; run(4); out.undo = C.pos === q.ans;
      const f0 = C.first; sure.click(); run(2); out.right = [C.locked, C.first - f0];
      /* stopping one short is a miss: back to the first number, and the mistake is kept for the report */
      C = play(1, q => !q.add && q.b >= 2); q = C.q; const e0 = (S.errs || []).length; hop(q.b - 1); sure.click(); run(2);
      out.miss = [C.tries, C.locked, C.pos === q.a, S.errs.length - e0, S.errs[S.errs.length - 1].g === q.a - (q.b - 1)];
      hop(q.b); sure.click(); run(2); out.second = [C.locked, C.first];
      /* a key held down is one hop, not one per repeat */
      C = play(1, q => q.add && q.a + 4 <= q.N); const key = rep => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: rep, bubbles: true })); key(false); run(24); for (let i = 0; i < 3; i++) { key(true); run(24); } out.held = C.pos - C.q.a;
      /* the ends of the line stop the hops */
      C = play(1, q => q.add); C.pos = C.q.N; C.hop.from = C.hop.to = C.q.N; hop(1); out.end = C.pos === C.q.N;
      /* level 3: no hops; the player walks to the number */
      C = play(3); q = C.q; out.l3 = [C.hop === null, C.q.N];
      D.P.set(st.c.x + C.B0 + q.ans * C.w, 0, st.c.z - C.fixCam.x); run(4); out.l3at = [C.pos === q.ans, !sure.hidden]; const f1 = C.first; sure.click(); run(2); out.l3right = [C.locked, C.first - f1];
      quit(); return out;
    });
    eq(r, { start: ['line', true, true, true, 11, true], noWalk: true, over: [true, true], undo: true, right: [true, 1], miss: [1, false, true, 1, true], second: [true, 0], held: 1, end: true, l3: [true, 20], l3at: [true, true], l3right: [true, 1] }, 'number line');
  });

  await test('balloon game: played through a scope - the player stands still, the stick moves the aim, and the shot goes to the balloon under the cross', async () => {
    await enter(page, 'contas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.contas, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[1]);
      const C = D.CH, sc = document.querySelector('#scope'), alive = () => C.balloons.filter(b => b.alive).length, n0 = alive(), out = {}; run(2);
      out.view = [!sc.hidden, document.body.classList.contains('fp'), Math.round(D.camera.fov), D.PL.g.visible, getComputedStyle(document.querySelector('#b-jump')).display, !document.querySelector('#b-fire').hidden];
      out.eye = Math.hypot(D.camera.position.x - D.P.x, D.camera.position.z - D.P.z) < .01 && Math.abs(D.camera.position.y - D.P.y - D.SCOPE.eye) < .01;
      /* the stick turns the aim and does not walk; up on the stick looks up; jumping does nothing */
      const p0 = [D.P.x, D.P.z], a0 = [C.ax, C.ay]; D.input.jx = 1; D.input.jy = -1; D.jump(); run(30); D.input.jx = D.input.jy = 0;
      out.stick = [D.P.x === p0[0] && D.P.z === p0[1] && D.P.y === 0, C.ax < a0[0] - .2, C.ay > a0[1] + .2];
      /* nothing under the cross: nothing is hit */
      C.ax = D.SCOPE.maxX; C.ay = D.SCOPE.minY; run(3); out.away = [D.aim() === null, sc.classList.contains('on')]; D.fire(); run(60); out.missed = alive() === n0;
      /* turn the scope to a balloon: the cross locks on it and the shot pops it */
      const b = C.balloons.find(b => b.alive), p = b.sp.position, dx = p.x - D.P.x, dz = p.z - D.P.z, dy = p.y - (D.P.y + D.SCOPE.eye);
      let a = Math.atan2(dx, dz) - C.a0; a = Math.atan2(Math.sin(a), Math.cos(a)); C.ax = a; C.ay = Math.atan2(dy, Math.hypot(dx, dz)) + .05; run(2);
      out.locked = [D.aim() === b, sc.classList.contains('on'), C.ret.visible]; D.fire(); for (let i = 0; i < 90 && b.alive; i++) D.step(1 / 60); out.hit = [!b.alive, n0 - alive()];
      out.spread = C.balloons.every(q => { let t = Math.atan2(q.x - D.P.x, q.z - D.P.z) - C.a0; t = Math.atan2(Math.sin(t), Math.cos(t)); return Math.abs(t) < D.SCOPE.maxX - .2 && Math.hypot(q.x - D.P.x, q.z - D.P.z) > 9; });
      return out;
    });
    eq(r, { view: [true, true, 40, false, 'none', true], eye: true, stick: [true, true, true], away: [true, false], missed: true, locked: [true, true, true], hit: [true, 1], spread: true }, 'scope');
    await page.evaluate(() => document.querySelector('#m-quit').click());
    eq(await page.evaluate(() => { const D = __ilhaDebug; D.step(1 / 60); return [document.querySelector('#scope').hidden, document.body.classList.contains('fp'), D.camera.fov, D.PL.g.visible, document.querySelector('#b-fire').hidden]; }), [true, false, 60, true, true], 'everything is back to normal after leaving the game');
  });

  await test('obby: the course is roomier, hops need no jump, and the portal at the end leads back to the start', async () => {
    await enter(page, 'contas');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.contas, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }; D.timeScale = .01; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[0]);
      const rows = k => D.PLATS.filter(p => p.row === k), gaps = [], edge = p => [p.cx - p.ha, p.cx + p.ha], wide = D.PLATS.filter(p => p.row == null && p.hb === 8).sort((a, b) => a.cx - b.cx), start = wide[0], decks = wide.slice(1);
      for (let k = 0; k < 5; k++) { const before = k ? decks[k - 1] : start; gaps.push(+(edge(rows(k)[0])[0] - edge(before)[1]).toFixed(2), +(edge(decks[k])[0] - edge(rows(k)[0])[1]).toFixed(2)); }
      const side = +(Math.abs(rows(0)[1].cz - rows(0)[0].cz) - 2 * rows(0)[0].hb).toFixed(2), far = +(rows(1)[0].cx - rows(0)[0].cx).toFixed(2);
      /* walk (no jump) from the start pad across the first hop onto the right platform */
      const walk = [];
      for (const pl of rows(0)) { D.startMode(st, st.modes[0]); const q = rows(0).find(p => p.cz === pl.cz); D.P.set(start.cx + start.ha - .2, 0, q.cz); let fell = false, on = false; for (let i = 0; i < 70; i++) { D.P.x += 6.2 / 60; D.step(1 / 60); if (D.P.y < -.5) fell = true; if (D.standing === q) { on = true; break; } } walk.push(!fell && on); document.querySelector('#m-quit').click(); }
      D.startMode(st, st.modes[0]); const right = rows(0).find(p => p.correct); D.P.set(right.cx, .05, right.cz); run(6); const walked = [walk, D.CH.row];
      for (let k = 1; k < 5; k++) { const p = rows(k).find(p => p.correct); D.P.set(p.cx, .05, p.cz); run(6); }
      const ended = !D.CH, last = decks[4]; D.P.set(last.cx + last.ha - 2.5, 0, 0); for (let i = 0; i < 90; i++) run(1);
      return { gaps: Math.max(...gaps), side, far, walked, ended, backAtStart: Math.abs(D.P.x - start.cx) < 4 && D.P.y > -.5 };
    });
    assert(r.gaps <= 1.6 && r.side >= 1.8 && r.far >= 15, `hop ${r.gaps}, space between answers ${r.side}, distance between rows ${r.far}`);
    eq([r.walked, r.ended, r.backAtStart], [[[true, true, true], 1], true, true], 'walked the hop to each of the three answer platforms without falling; round ended; portal took the player back');
    await page.waitForSelector('.result h2', { timeout: 6000 }); await page.evaluate(() => { __ilhaDebug.timeScale = 1; __ilhaDebug.closeSheet(); });
  });

  await test('shop: one change per round - wearing or buying spends it, and a round with a star gives it back (only one, never more)', async () => {
    const p = await open(1024, 768);
    await p.evaluate(() => { const D = __ilhaDebug, S = D.S(); S.coins = 90; S.owned.push('hat:bone'); D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); });
    await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.waitForSelector('#s-pass');
    const st = () => p.evaluate(() => { const S = __ilhaDebug.S(), ps = document.querySelector('#s-pass'); return [S.edit, S.look.hat, S.look.shirt, S.coins, ps ? ps.className : null, !!document.querySelector('.quiz')]; });
    eq(await st(), [true, 'nenhum', 'azul', 90, 'pass on', false], 'at first');
    await p.click('.item[data-k="bone"]'); await p.click('#w-back'); eq(await st(), [true, 'nenhum', 'azul', 90, 'pass on', false], 'backing out of a change keeps the pass');
    await p.click('.item[data-k="bone"]'); await p.click('#w-ok'); eq(await st(), [false, 'bone', 'azul', 90, 'pass off', false], 'wearing an owned cap spends the pass');
    await p.click('.item[data-k="nenhum"]'); await p.click('.tab[data-t="shirt"]'); await p.click('.item[data-k="vermelho"]');
    eq(await st(), [false, 'bone', 'azul', 90, 'pass off', false], 'with the pass spent, nothing can be changed or bought');
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), st = D.STM.formas, out = []; D.closeSheet(); S.misOn = false; /* without the mission, any round with a star gives the change back */
      D.finishChallenge(st, 0, 5, 0, 1, null, false, true); out.push(S.edit); D.finishChallenge(st, 3, 5, 3, 1, null, false, true); out.push(S.edit); D.finishChallenge(st, 5, 5, 5, 1, null, false, true); out.push(S.edit); S.coins = 60; return out; });
    eq(r, [false, true, true], 'pass after a round with no star, a round with stars, and one more round');
    await p.evaluate(() => { const D = __ilhaDebug; D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); });
    await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.click('.tab[data-t="shirt"]'); await p.click('.item[data-k="vermelho"]');
    await p.waitForSelector('.quiz .btn.big'); const coins = await p.evaluate(() => __ilhaDebug.S().coins); await p.click(`.quiz .btn.big[data-v="${coins - 30}"]`);
    eq(await st(), [false, 'bone', 'vermelho', coins - 30, 'pass off', false], 'buying a shirt spends the pass too');
    await p.click('.item[data-k="azul"]'); eq((await st()).slice(0, 3), [false, 'bone', 'vermelho'], 'and the old shirt cannot be put back until another round is played');
    await p.context().close();
  });

  await test('shop: buying takes the right answer to a sum, in one try and among 5 options; a wrong answer buys nothing and spends the change', async () => {
    const p = await open(1024, 768);
    const shop = async (coins, tab) => { await p.evaluate(c => { const D = __ilhaDebug, S = D.S(); S.coins = c; S.edit = true; D.closeSheet(); D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); }, coins);
      await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.click(`.tab[data-t="${tab}"]`); };
    const quiz = () => p.evaluate(() => { const o = [...document.querySelectorAll('.quiz .btn.big')].map(b => +b.dataset.v), sum = document.querySelector('.quiz .sum'); let ans = null;
      if (sum) { const m = /(\d+) ([+−]) (\d+)/.exec(sum.textContent); ans = m[2] === '+' ? +m[1] + +m[3] : +m[1] - +m[3]; }
      return { n: o.length, distinct: new Set(o).size, change: /sobrar/.test(document.querySelector('.quiz').textContent), ans, has: ans == null ? o.includes(40) : o.includes(ans), neg: o.some(v => v < 0), sum: sum ? sum.textContent : '' }; });
    const state = () => p.evaluate(() => { const S = __ilhaDebug.S(); return [S.coins, S.owned.filter(x => x.startsWith('shirt:')).join(), S.look.shirt, S.edit, !!document.querySelector('.quiz')]; });
    await shop(70, 'shirt'); await p.click('.item[data-k="vermelho"]'); await p.waitForSelector('.quiz .btn.big');
    const q1 = await quiz(); eq([q1.n, q1.distinct, q1.change, q1.has, q1.neg], [5, 5, true, true, false], 'the change, with five options');
    await p.click('.quiz .btn.big:not([data-v="40"])'); await p.waitForSelector('#q-x');
    assert(/70 − 30 = 40/.test(await p.evaluate(() => document.querySelector('.quiz').textContent)), 'the sum is shown after a miss');
    await p.click('#q-x'); await p.click('.item[data-k="vermelho"]');
    eq(await state(), [70, '', 'azul', false, false], 'a wrong answer buys nothing and spends the change, so there is no second guess');
    await shop(70, 'shirt'); await p.click('.item[data-k="vermelho"]'); await p.waitForSelector('.quiz .btn.big'); await p.click('.quiz .btn.big[data-v="40"]');
    eq(await state(), [40, 'shirt:vermelho', 'vermelho', false, false], 'the right answer buys the shirt');
    /* with more than 100 coins the change would be a three-digit subtraction, so it is a sum from the child's level - and backing out does not draw another */
    await shop(150, 'shirt'); await p.click('.item[data-k="verde"]'); await p.waitForSelector('.quiz .btn.big');
    const q3 = await quiz(); eq([q3.n, q3.distinct, q3.change, q3.has], [5, 5, false, true], 'question with 150 coins');
    await p.click('#q-back'); await p.click('.item[data-k="laranja"]'); await p.waitForSelector('.quiz .btn.big');
    const q4 = await quiz(); eq(q4.sum, q3.sum, 'the same sum after backing out and picking another shirt');
    await p.click(`.quiz .btn.big[data-v="${q4.ans}"]`); eq(await state(), [120, 'shirt:vermelho,shirt:laranja', 'laranja', false, false], 'bought with the right answer');
    /* every question the shop can ask has five different options with the answer among them */
    const bad = await p.evaluate(() => { const S = __ilhaDebug.S(), bad = [];
      for (let c = 20; c <= 320; c += 7) for (const [tab, k] of [['pants', 'cinza'], ['shirt', 'laranja'], ['kit', 'arg'], ['pet', 'dragao']]) { const t = __ilhaDebug.CAT[tab].find(x => x.k === k); if (c < t.p) continue; S.coins = c;
        const Q = __ilhaDebug.buyQ(t); if (Q.opts.length !== 5 || new Set(Q.opts).size !== 5 || !Q.opts.includes(Q.ans) || Q.opts.some(v => v < 0) || (Q.change && Q.ans !== c - t.p) || Q.change !== (c <= 100)) bad.push([c, k, Q.opts, Q.ans]); }
      return bad.slice(0, 4); });
    eq(bad, [], 'malformed shop questions');
    await p.context().close();
  });

  await test('shop: skin colour is always free to change, and trousers cannot be picked under a football kit', async () => {
    const p = await open(1024, 768);
    await p.evaluate(() => { const D = __ilhaDebug, S = D.S(); S.coins = 90; S.edit = false; S.owned.push('kit:bra', 'pants:cinza'); S.look.shirt = 'bra'; D.buildPlayer(); D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); });
    await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.click('.tab[data-t="skin"]');
    await p.click('.item[data-k="s4"]'); eq(await p.evaluate(() => [__ilhaDebug.S().look.skin, __ilhaDebug.S().edit, document.querySelector('#s-pass').className]), ['s4', false, 'pass on'], 'skin changed with the change already spent');
    await p.evaluate(() => { __ilhaDebug.S().edit = true; }); await p.click('.item[data-k="s1"]'); eq(await p.evaluate(() => [__ilhaDebug.S().look.skin, __ilhaDebug.S().edit]), ['s1', true], 'and changing skin does not spend it');
    await p.click('.tab[data-t="pants"]'); await p.click('.item[data-k="cinza"]'); await p.click('.item[data-k="verde"]');
    eq(await p.evaluate(() => { const S = __ilhaDebug.S(); return [S.look.pants, S.edit, S.coins, !!document.querySelector('.quiz'), /calção/.test(document.querySelector('#toast').textContent)]; }), ['jeans', true, 90, false, true], 'trousers under a kit: nothing is spent, and the reason is shown');
    await p.context().close();
  });

  await test('hair: 22 cuts on offer, each with its picture; a cut is built from its own boxes, loses its top under a hat, and the name stays above it', async () => {
    const p = await open(1024, 768);
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), hair = D.CAT.hair, n = k => { S.look.hair = k; D.buildPlayer(); return D.PL.head.children.length; };
      const out = { cuts: hair.length, shapes: new Set(hair.map(h => h.sh)).size, known: hair.every(h => D.HAIR_SHAPES[h.sh] && h.cs.length && h.c === h.cs[0]), plain: n('castanho'), moicano: n('moicano'), black: n('black'), trancas: n('trancas') };
      S.look.hat = 'bone'; out.moicanoHat = n('moicano'); S.look.hat = 'nenhum'; n('castanho'); out.tagPlain = D.PL.ns.position.y; n('fogo'); out.tagFire = D.PL.ns.position.y; out.top = D.PL.top;
      S.coins = 0; S.look.hair = 'castanho'; D.buildPlayer(); D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); return out; });
    eq([r.cuts, r.shapes, r.known], [22, 16, true], 'cuts, different shapes, all well formed');
    assert(r.moicano !== r.plain && r.black !== r.plain && r.trancas > r.plain + 8 && r.moicanoHat < r.moicano, `boxes on the head: ${JSON.stringify(r)}`);
    assert(r.tagPlain < 3.45 && r.tagFire > r.top + .3 && r.top > 3.7, `name tag: ${JSON.stringify(r)}`);
    await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.click('.tab[data-t="hair"]');
    const pics = await p.evaluate(() => [...document.querySelectorAll('.item img.jr')].map(i => i.src));
    eq([pics.length, pics.every(s => s.startsWith('data:image/png')), new Set(pics).size], [22, true, 22], 'pictures in the shop');
    await p.context().close();
  });

  await test('football: the Portugal shirt has the 7 on the back, the others keep the 10', async () => {
    const r = await page.evaluate(() => { const D = __ilhaDebug, S = D.S(), kits = D.CAT.kit, old = S.look.shirt; S.look.shirt = 'por'; D.buildPlayer(); let back = null; D.PL.g.traverse(o => { if (o.isMesh && Array.isArray(o.material) && o.material[5] && o.material[5].map && !o.userData.head) back = o.material[5].map.image; });
      const px = back ? [...back.getContext('2d').getImageData(0, 0, back.width, back.height).data] : [], gold = px.filter((v, i) => i % 4 === 1 && v > 180 && px[i - 1] > 220 && px[i + 1] < 80).length; S.look.shirt = old; D.buildPlayer();
      return { seven: kits.filter(k => k.no === '7').map(k => k.k), other: kits.filter(k => k.no && k.no !== '7').length, gold }; });
    eq([r.seven, r.other], [['por'], 0], 'who wears the 7');
    assert(r.gold > 60, `the number is drawn on the back of the shirt (${r.gold} gold pixels)`);
  });

  await test('celebrations: every new medal unlocks the next one and chooses it; a locked one cannot be picked; each plays to the end and leaves the pose clean', async () => {
    const p = await open(1024, 768);
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), out = {}; out.start = [S.celes, S.cele];
      D.finishChallenge(D.STM.formas, 5, 5, 5, 1, null, false, true); out.gold = [S.celes, S.cele]; D.finishChallenge(D.STM.formas, 5, 5, 5, 1, null, false, true); out.same = [S.celes, S.cele];
      D.finishChallenge(D.STM.contas, 1, 5, 1, 1, null, false, true); out.bronze = [S.celes, S.cele]; D.finishChallenge(D.STM.ordem, 0, 5, 0, 1, null, false, true); out.none = [S.celes, S.cele]; return out; });
    eq(r, { start: [0, ''], gold: [1, 'siu'], same: [1, 'siu'], bronze: [2, 'ceu'], none: [2, 'ceu'] }, 'unlocking');
    await p.click('#b-menu'); await p.click('#mn-cele');
    eq(await p.evaluate(() => [document.querySelectorAll('.item').length, document.querySelectorAll('.item.poor').length, document.querySelector('.item.eq').dataset.k]), [11, 8, 'ceu'], 'list: all, locked, chosen');
    await p.click('.item[data-k="mascara"]'); eq(await p.evaluate(() => __ilhaDebug.S().cele), 'ceu', 'a locked celebration is not chosen');
    await p.click('.item[data-k="siu"]'); eq(await p.evaluate(() => [__ilhaDebug.S().cele, __ilhaDebug.ANIM && __ilhaDebug.ANIM.type, __ilhaDebug.ANIM && __ilhaDebug.ANIM.ce.k, __ilhaDebug.camMode, document.querySelector('#ov').hidden]), ['siu', 'cele', 'siu', 'cele', true], 'choosing closes the list and plays it');
    const run = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), bad = []; D.closeSheet();
      for (const c of D.CELES) { D.playAnim('cele', null, c.k); let moved = false; for (let i = 0; i < (c.d + .3) * 30; i++) { D.step(1 / 30); const L = D.PL; if (D.ANIM && (L.armL.rotation.z || L.legL.rotation.z || L.legL.rotation.x || L.g.rotation.x || L.g.position.y !== D.P.y)) moved = true; }
        const L = D.PL; if (D.ANIM || !moved || L.armL.rotation.z || L.armR.rotation.z || L.legL.rotation.z || L.legR.rotation.z || L.g.rotation.x || L.g.rotation.z || L.head.rotation.x || D.camMode !== 'follow') bad.push(c.k); }
      S.cele = 'siu'; D.playAnim('win'); const chosen = [D.ANIM.type, D.ANIM.ce.k]; S.cele = ''; D.playAnim('win'); const plain = D.ANIM.type; S.cele = 'mascara'; D.playAnim('win'); const locked = D.ANIM.type; S.cele = 'siu';
      for (let i = 0; i < 120; i++) D.step(1 / 30); return { bad, chosen, plain, locked }; });
    eq(run, { bad: [], chosen: ['cele', 'siu'], plain: 'win', locked: 'win' }, 'playing the celebrations');
    /* the 🎉 button opens the list; picking one there chooses it and plays it */
    await p.click('#b-cele'); eq(await p.evaluate(() => [document.querySelectorAll('.item').length, !!document.querySelector('.tabs'), document.querySelector('.item.eq').dataset.k]), [11, false, 'siu'], 'list from the button');
    await p.click('.item[data-k="ceu"]'); eq(await p.evaluate(() => [__ilhaDebug.S().cele, __ilhaDebug.ANIM.ce.k, document.querySelector('#ov').hidden]), ['ceu', 'ceu', true], 'picked from the button');
    await p.click('#b-cele'); await p.click('.item[data-k=""]'); eq(await p.evaluate(() => [__ilhaDebug.S().cele, __ilhaDebug.ANIM.type]), ['', 'win'], 'the plain victory dance can be chosen back');
    /* the same list is a tab of the shop */
    await p.evaluate(() => { const D = __ilhaDebug; for (let i = 0; i < 130; i++) D.step(1 / 30); D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); });
    await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.click('.tab[data-t="cele"]');
    eq(await p.evaluate(() => [document.querySelectorAll('.item').length, document.querySelector('.tab.on').dataset.t, document.querySelectorAll('.tab').length]), [11, 'cele', 9], 'celebrations tab in the shop');
    await p.click('.tab[data-t="hat"]'); eq(await p.evaluate(() => [!!document.querySelector('#s-pass'), document.querySelector('.tab.on').dataset.t]), [true, 'hat'], 'and back to the hats');
    await p.click('.tab[data-t="cele"]'); await p.click('.item[data-k="siu"]'); eq(await p.evaluate(() => [__ilhaDebug.S().cele, __ilhaDebug.S().edit, document.querySelector('#ov').hidden]), ['siu', true, true], 'choosing in the shop does not spend the change');
    const btn = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), b = document.querySelector('#b-cele'), st = D.STM.formas, out = [b.hidden]; for (let i = 0; i < 130; i++) D.step(1 / 30);
      D.startMode(st, st.modes[0]); D.step(1 / 60); out.push(b.hidden); document.querySelector('#b-menu').click(); document.querySelector('#mn-cele').click(); document.querySelector('.item[data-k="ceu"]').click();
      out.push(S.cele, !!D.ANIM, document.querySelector('#ov').hidden, document.querySelector('.item.eq').dataset.k); D.closeSheet(); document.querySelector('#m-quit').click(); D.step(1 / 60); out.push(b.hidden); return out; });
    eq(btn, [false, true, 'ceu', false, false, 'ceu', false], 'the button is hidden during a challenge; choosing from the menu then only chooses, without playing');
    await p.context().close();
  });

  await test('voices: every character has a pitch and a pace of their own, the host of each game reads its questions, and the voices of the device are dealt out by character', async () => {
    const p = await open(1024, 768);
    const r = await p.evaluate(() => { const D = __ilhaDebug, said = []; let voices = [];
      /* a plain stand-in for the utterance, so that made-up voices can be set on it */
      window.SpeechSynthesisUtterance = function (text) { this.text = text; this.pitch = 1; this.rate = 1; this.voice = null; };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: u => said.push([Math.round(u.pitch * 100) / 100 + '/' + Math.round(u.rate * 100) / 100, u.voice ? u.voice.name : '']), cancel() {}, getVoices: () => voices } });
      const mk = name => ({ name, lang: 'pt-BR' }), set = names => { voices = names.map(mk); D.pickVoice(); };
      const say = who => { said.length = 0; D.speak('oi', null, true, who); return said[0]; }, names = Object.keys(D.VOICES), out = {};
      /* one voice on the device: everybody uses it, each with a pitch and a pace of their own */
      set(['Google português do Brasil']); const one = names.map(n => say(n)); out.one = [names.length, new Set(one.map(x => x[0])).size, new Set(one.map(x => x[1])).size, say(null)[0], one.some(x => x[0] === say(null)[0])];
      out.none = say(undefined)[0]; const vila = D.STM.vocab; D.startMode(vila, vila.modes[1]); out.master = say(undefined)[0]; document.querySelector('#m-quit').click(); D.startMode(vila, vila.modes[0]); out.host = say(undefined)[0] === say(vila.npc.name)[0]; document.querySelector('#m-quit').click();
      const v = D.VOICES; out.range = v['Seu Zé'].p <= .5 && v.Mestre.p <= .6 && v.Ana.p >= 1.8 && names.filter(n => D.STM && Object.values(D.STM).some(s => s.npc.name === n)).every(n => v[n].p <= 1.6);
      /* several voices: men get a man's voice, women a woman's, nobody shares one while there are enough, and the pitch-deaf Google voice is left to the narrator */
      set(['Microsoft Maria - Portuguese (Brazil)', 'Google português do Brasil', 'Microsoft Daniel', 'Microsoft Francisca Online (Natural)', 'Microsoft Antonio Online (Natural)', 'Microsoft Thalita Online (Natural)', 'Microsoft Fabio Online (Natural)']);
      const cast = Object.fromEntries(names.map(n => [n, say(n)[1]])), men = names.filter(n => v[n].g === 'm'), women = names.filter(n => v[n].g === 'f');
      out.cast = [men.every(n => /Daniel|Antonio|Fabio/.test(cast[n])), women.every(n => /Maria|Francisca|Thalita/.test(cast[n])), new Set(men.slice(0, 3).map(n => cast[n])).size, new Set(women.slice(0, 3).map(n => cast[n])).size, names.some(n => /Google/.test(cast[n]))];
      /* voices with names the game does not know are still shared out, so the characters do not all sound the same */
      set(['Voz A', 'Voz B', 'Voz C']); out.unknown = new Set(names.map(n => say(n)[1])).size;
      /* with as many unknown voices as characters, every character gets one of their own (men and women draw from the same voices) */
      set(names.map((_, i) => 'Voz ' + i)); out.each = new Set(names.map(n => say(n)[1])).size; set(['Microsoft Daniel', 'Voz A', 'Voz B']); out.mixed = [say('Seu Zé')[1], new Set(names.slice(0, 3).map(n => say(n)[1])).size]; set(['Voz A', 'Voz B', 'Voz C']);
      return out; });
    eq(r, { one: [13, 13, 1, '1/0.9', false], none: '1/0.9', master: '0.6/0.8', host: true, range: true, cast: [true, true, 3, 3, false], unknown: 3, each: 13, mixed: ['Microsoft Daniel', 3] }, 'voices');
    /* the Voices screen: says how many voices the device has and lets each character be heard */
    await p.evaluate(() => { const D = __ilhaDebug; D.closeSheet(); document.querySelector('#b-menu').click(); document.querySelector('#mn-voz').click(); });
    const scr = await p.evaluate(() => { const info = document.querySelector('#v-info').textContent, items = document.querySelectorAll('.item'); window.__said = null; const ss = window.speechSynthesis, old = ss.speak; ss.speak = u => { window.__said = Math.round(u.pitch * 100) / 100; };
      document.querySelector('.item[data-k="Seu Zé"]').click(); ss.speak = old; return [items.length, /tem 3 vozes/.test(info), window.__said]; });
    eq(scr, [14, true, .5], 'voices screen: narrator and 13 characters, the count of voices, and a sample in the character\'s voice');
    await p.context().close();
  });

  await test('my own siuuu: a recording or an audio file replaces the game shout, stays on this device, and can be removed', async () => {
    const p = await open(1024, 768); await p.context().grantPermissions(['microphone']);
    /* a short real WAV: 0.25 s of a 440 Hz tone, 8 kHz, 8 bits */
    const wav = n => { const b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(90 * Math.sin(i * 2 * Math.PI * 440 / 8000)); return b; };
    const state = () => p.evaluate(() => [document.querySelector('#u-state').textContent, !!__ilhaDebug.siu, (localStorage.getItem('ilha-numeros-siu') || '').slice(0, 10), document.querySelector('#u-play').disabled]);
    const pick = async file => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#u-file')]); await fc.setFiles(file); };
    eq(await p.evaluate(() => { document.querySelector('#b-cele').click(); return !!document.querySelector('#c-siu'); }), false, 'no button while the Siuuu is still locked');
    await p.evaluate(() => { const D = __ilhaDebug; D.closeSheet(); D.finishChallenge(D.STM.formas, 5, 5, 5, 1, null, false, true); document.querySelector('#b-cele').click(); document.querySelector('#c-siu').click(); });
    eq(await state(), ['Usando o som do jogo.', false, '', true], 'at first');
    await pick({ name: 'siu.wav', mimeType: 'audio/wav', buffer: wav(2000) }); await p.waitForFunction(() => /seu Siuuu/.test(document.querySelector('#u-state').textContent), null, { timeout: 8000 });
    eq((await state()).slice(1), [true, 'data:audio', false], 'an audio file is kept on the device');
    eq(await p.evaluate(() => __ilhaDebug.siuBuf), true, 'and it is decoded for the game\'s own audio, which plays without a touch');
    eq(await p.evaluate(() => { let threw = ''; try { __ilhaDebug.celeSnd.siu(); __ilhaDebug.playSiu(); } catch (e) { threw = String(e); } return [threw, document.querySelector('#u-back') ? 1 : 0]; }), ['', 1], 'the celebration sound plays it without error');
    await p.click('#u-back'); eq(await p.evaluate(() => document.querySelector('#c-siu').textContent), '🎤 Meu Siuuu ✓', 'the list shows there is a sound of your own'); await p.click('#c-siu');
    await pick({ name: 'foto.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('isto não é um áudio de verdade, é só texto') }); await p.waitForFunction(() => /não consegue tocar/.test(document.querySelector('#u-state').textContent), null, { timeout: 9000 });
    eq((await state()).slice(1), [true, 'data:audio', false], 'a file that is not audio is refused, and the old sound stays');
    await pick({ name: 'longo.wav', mimeType: 'audio/wav', buffer: wav(1600000) }); await p.waitForFunction(() => /grande demais/.test(document.querySelector('#u-state').textContent), null, { timeout: 8000 });
    eq((await state()).slice(1), [true, 'data:audio', false], 'a file that is too big is refused');
    await p.click('#u-del'); eq(await state(), ['Pronto: voltou o som do jogo.', false, '', true], 'removed: back to the game sound');
    /* record from the (fake) microphone: count-down, three seconds, saved */
    await p.click('#u-rec'); await p.waitForFunction(() => /Gravado/.test(document.querySelector('#u-state').textContent), null, { timeout: 15000 });
    eq((await state()).slice(1), [true, 'data:audio', false], 'the recording is kept on the device');
    eq(await p.evaluate(() => JSON.stringify(__ilhaDebug.S()).includes('data:audio')), false, 'and it is not part of the save (nor of the backup)');
    await p.context().close();
  });

  await test('sound: the ambience runs, the music button goes rock, calm, off, and every celebration has its sound', async () => {
    const p = await open(1024, 768);
    const states = []; for (let i = 0; i < 3; i++) { await p.click('#b-music'); states.push(await p.evaluate(() => { const S = __ilhaDebug.S(), b = document.querySelector('#b-music'); return [S.music, S.musStyle, b.textContent, b.classList.contains('off')].join(); })); if (i === 0) await p.waitForTimeout(700); }
    eq(states, ['true,calma,🎹,false', 'false,calma,🎹,true', 'true,rock,🎸,false'], 'music button');
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), snd = Object.keys(D.celeSnd).sort(), keys = D.CELES.map(c => c.k).sort(); let threw = ''; try { for (const k of snd) D.celeSnd[k](); S.sound = false; for (const k of snd) D.celeSnd[k](); S.sound = true; } catch (e) { threw = String(e); }
      return { amb: D.amb, same: JSON.stringify(snd) === JSON.stringify(keys), threw }; });
    eq(r, { amb: true, same: true, threw: '' }, 'ambience and celebration sounds');
    await p.context().close();
  });

  await test('mission: three rounds picked by the game (a sums game, the weakest station, a free one) give the change in the shop, and then a new mission starts', async () => {
    const p = await open(1024, 768);
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), M = D.STM, out = {}, fin = (id, mi, first) => D.finishChallenge(M[id], first, 5, first, 1, mi == null ? null : M[id].modes[mi], false, true), L = () => D.mission().map(i => [i.id, i.mi, i.done]), done = () => L().filter(i => i[2]).length;
      const l0 = L(), weak = l0[1][0], other = weak === 'formas' ? 'n10' : 'formas'; S.edit = false;
      out.first = [l0.length, l0[0][0], M.contas.modes[l0[0][1]].k, weak !== 'contas' && !!M[weak], l0[2][0], document.querySelector('#h-mis').textContent, document.querySelector('#b-mis').hidden];
      fin(other, 0, 0); out.noStar = done();                                                   // a round with no star fills nothing
      fin(other, 0, 3); out.free = [L()[2][2], L()[1][2], S.edit];                              // a game the mission does not name fills the free item
      fin(other, 0, 3); out.again = done();                                                     // and a second one fills nothing more
      fin('contas', 2, 3); out.wrongGame = [L()[0][2], done()];                                 // the sums item wants its own game: the kart is not it
      fin(weak, 1, 3); out.weak = [L()[1][2], S.edit, document.querySelector('#h-mis').textContent];
      const coins = S.coins, day = D.DAY().m; fin('contas', l0[0][1], 3); const l1 = L();
      out.done = [S.edit, S.mis.n, done(), S.coins - coins >= 5, D.DAY().m - day, M.contas.modes[l1[0][1]].k !== M.contas.modes[l0[0][1]].k, l1[1][0] !== weak, document.querySelector('#h-mis').textContent];
      return out; });
    eq(r, { first: [3, 'contas', 'bus', true, '', '0/3', false], noStar: 0, free: [true, false, false], again: 1, wrongGame: [false, 1], weak: [true, false, '2/3'], done: [true, 1, 0, true, 1, true, true, '0/3'] }, 'mission');
    /* the mission sheet: three lines, and "Jogar" travels to the station and starts the game it names */
    await p.click('#b-mis'); const want = await p.evaluate(() => { const D = __ilhaDebug, i = D.mission()[0]; return [document.querySelectorAll('.mrow').length, document.querySelectorAll('.mrow .btn').length, D.STM.contas.modes[i.mi].k]; });
    eq(want.slice(0, 2), [3, 2], 'lines and play buttons'); await p.click('.mrow .btn[data-k="0"]');
    await p.waitForFunction(k => __ilhaDebug.CH && __ilhaDebug.CH.type === k && __ilhaDebug.WORLD && __ilhaDebug.WORLD.id === 'contas', want[2], { timeout: 8000 });
    eq(await p.evaluate(() => { const D = __ilhaDebug; document.querySelector('#b-mis').click(); const out = [[...document.querySelectorAll('.mrow .btn')].every(b => b.disabled), /Termine a rodada/.test(document.querySelector('#sheet').textContent)]; D.closeSheet(); const ch = D.CH; D.STM && document.querySelector('#b-mis').click(); document.querySelectorAll('.mrow .btn').forEach(b => b.click()); D.closeSheet(); return [...out, D.CH === ch]; }), [true, true, true], 'during a round the mission does not take the player elsewhere');
    eq(await p.evaluate(() => { const D = __ilhaDebug, S = D.S(); S.mis.list[1].mi = 7; const L = D.mission(); return [L[1].mi, L[2].mi, L.length]; }), [-1, -1, 3], 'a damaged mission is replaced');
    /* switched off in the parents area: the old rule is back, and the button goes away */
    eq(await p.evaluate(() => { const D = __ilhaDebug, S = D.S(); document.querySelector('#m-quit').click(); D.parents(); document.querySelector('#p-mis').click(); const off = [S.misOn, document.querySelector('#b-mis').hidden]; D.closeSheet(); S.edit = false; D.finishChallenge(D.STM.formas, 3, 5, 3, 1, null, false, true); return [...off, S.edit]; }), [false, true, true], 'mission off');
    await p.context().close();
  });

  await test('rest: a station with a gold round waits for a medal in each of the others, mission games stay open, and parents can release it', async () => {
    const p = await open(1024, 768);
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), M = D.STM, out = {}, ids = Object.keys(M), fin = (id, first, silent, mi) => D.finishChallenge(M[id], first, 5, first, 1, mi == null ? null : M[id].modes[mi], false, silent !== false), kinds = () => [document.querySelectorAll('.mode').length, document.querySelectorAll('.travel button').length];
      fin('formas', 5, false); out.gold = [D.resting(M.formas), S.rest.formas.need.length, !!document.querySelector('#r-again'), /descansar/.test(document.querySelector('.result').textContent)]; D.closeSheet();
      D.talk(M.formas); out.sheet = kinds(); D.closeSheet(); D.talk(M.formas, true); out.viaMission = kinds(); D.closeSheet();
      fin('n10', 5); out.second = [D.resting(M.n10), S.rest.n10.need.length, S.rest.formas.need.length, S.rest.n10.need.includes('formas')];
      fin('ordem', 0); out.noStar = S.rest.formas.need.includes('ordem');
      const rest = ids.filter(id => id !== 'formas' && id !== 'n10'); rest.slice(0, -1).forEach(id => fin(id, 1)); out.almost = [D.resting(M.formas), S.rest.formas.need.join()];
      fin(rest[rest.length - 1], 1); out.back = [D.resting(M.formas), D.resting(M.n10), Object.keys(S.rest).length]; D.talk(M.formas); out.open = kinds(); D.closeSheet();
      /* a resting station that the mission asks for can be played from the mission */
      const mi = D.mission()[0].mi, otherGame = mi === 2 ? 0 : 2; fin('contas', 5, true, otherGame); D.talk(M.contas); out.misBtn = [D.resting(M.contas), !!document.querySelector('#rs-mis'), document.querySelectorAll('.mode').length]; D.closeSheet();
      /* the parents can switch it off, or release what is resting */
      S.restOn = false; out.off = D.resting(M.contas); S.restOn = true; S.misOn = false; D.parents(); document.querySelector('#p-rs').click(); document.querySelector('#p-rs').click(); out.wiped = [D.S().misOn, D.S().restOn, D.S().mis.n]; D.S().rest = { contas: { need: ['formas'] } }; D.parents(); const btn = document.querySelector('#p-free'); out.btn = [btn.disabled, /\(1\)/.test(btn.textContent)]; btn.click(); out.released = [Object.keys(D.S().rest).length, D.resting(M.contas)]; D.closeSheet();
      return out; });
    eq(r, { gold: [true, 7, false, true], sheet: [0, 7], viaMission: [2, 0], second: [true, 6, 6, false], noStar: true, almost: [true, r.almost[1]], back: [false, false, 0], open: [2, 0], misBtn: [true, true, 0], off: false, wiped: [false, true, 0], btn: [false, true], released: [0, false] }, 'rest');
    assert(r.almost[1].split(',').length === 1, `one station left before the rest ends: ${r.almost[1]}`);
    await p.context().close();
  });

  await test('report: situation of each sums skill from the latest answers, the kinds of mistake, the week, what to do next, and the text to copy', async () => {
    const p = await open(1024, 768);
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(), rec = (skill, pattern) => [...pattern].forEach(c => D.record(skill.split('.')[0], c === '1', skill));
      rec('contas.juntar', '1111101111'); rec('contas.sub', '010010'); rec('contas.soma', '110'); rec('n10.cont', '0100100');
      [['9 − 4', 5, 6], ['8 − 3', 5, 4], ['6 − 2', 4, 5], ['7 − 2', 5, 9]].forEach(e => D.noteErr('contas.sub', ...e)); D.noteErr('n10.cont', 'quantos?', 3, 4);
      D.dayT = 125.4; D.finishChallenge(D.STM.contas, 3, 5, 3, 1, null, false, true);
      const R = D.reportData(), st = id => R.sums.find(x => x.id === id).s, text = D.reportText(R), day = D.DAY();
      return { states: [st('contas.juntar'), st('contas.sub'), st('contas.soma'), st('contas.tirar')], hist: S.sk['contas.juntar'].h, pat: R.pat, week: [R.week.days, R.week.q, R.week.f, R.week.r, R.week.t >= 125 && R.week.t < 200], day: [day.q, day.f, day.r, day.t === R.week.t, day.st.contas],
        tips: [R.tips.some(t => /por 1/.test(t)), R.tips.some(t => /conta escrita/.test(t)), R.tips.some(t => /Contar e achar o número/.test(t))], errs: R.errs.length,
        text: [/ADIÇÃO E SUBTRAÇÃO/.test(text), /Subtração \(conta escrita\): Precisa de ajuda \(2\/6 de primeira\)/.test(text), /9 − 4: respondeu 6, era 5/.test(text), /O QUE FAZER AGORA/.test(text), /<b>|undefined|NaN/.test(text)] }; });
    eq(r, { states: [4, 2, 1, 0], hist: '1111101111', pat: { n: 4, by1: 3, swap: 1, first: 0 }, week: [1, 26, 15, 1, true], day: [26, 15, 1, true, 1], tips: [true, true, true], errs: 4, text: [true, true, true, true, false] }, 'report data');
    await p.evaluate(() => { __ilhaDebug.parents(); document.querySelector('#p-rep').click(); });
    eq(await p.evaluate(() => [!!document.querySelector('.rep'), document.querySelectorAll('.rep .tbl')[0].querySelectorAll('tbody tr').length, document.querySelectorAll('.week .wd').length, document.querySelectorAll('.week .wd.on').length, document.querySelectorAll('.errs span').length, document.querySelectorAll('.rep .tbl')[1].querySelectorAll('tbody tr').length, document.querySelectorAll('.hist i').length >= 19]), [true, 11, 7, 1, 4, 8, true], 'report on screen');
    await p.click('#rp-back'); eq(await p.evaluate(() => !!document.querySelector('#p-rep')), true, 'back to the parents area');
    await p.context().close();
  });

  await test('master game: at least 10 kinds of step, orders of 1, 2 and 3 steps by level, and the odd trick', async () => {
    const r = await page.evaluate(() => { const kinds = new Set(), sizes = { 1: new Set(), 2: new Set(), 3: new Set() }, tricks = [0, 0, 0], bad = [];
      for (const L of [1, 2, 3]) for (let i = 0; i < 1500; i++) { const q = window.__ilha.genSimon(L); q.steps.forEach(s => kinds.add(s.k)); if (q.trick) tricks[L - 1]++; else sizes[L].add(q.steps.length);
        const want = q.trick ? /^[A-ZÀ-Ú][^:]*!$/ : [0, /^O mestre mandou: [^,]+!$/, /^O mestre mandou: PRIMEIRO .+, DEPOIS .+!$/, /^O mestre mandou: PRIMEIRO .+, DEPOIS .+ e POR FIM .+!$/][q.steps.length];
        if (!want.test(q.text) || /undefined|null/.test(q.text) || new Set(q.steps.map(s => s.k)).size !== q.steps.length || (q.trick && /mestre/i.test(q.text))) bad.push(q.text);
        const b = q.steps.findIndex(s => s.k === 'bring'); if (b >= 0 && !q.steps.slice(0, b).some(s => s.k === 'take' && s.it === q.steps[b].it)) bad.push('bring without take: ' + q.text); }
      return { kinds: [...kinds].sort(), sizes: [1, 2, 3].map(L => [...sizes[L]].sort()), tricks, bad: bad.slice(0, 5) }; });
    eq(r.bad, [], 'malformed orders');
    eq(r.kinds, ['around', 'bring', 'carry', 'color', 'flee', 'go', 'hide', 'jump', 'ring', 'seek', 'statue', 'tag', 'take'], 'kinds of step');
    eq(r.sizes, [[1], [2], [3]], 'steps per order at levels 1, 2, 3');
    assert(r.tricks[0] === 0 && r.tricks[1] > 80 && r.tricks[2] > 80, `tricks per level: ${r.tricks}`);
  });

  await test('master game: steps count only in the order given, a wrong action costs a heart, and a trick must not be obeyed', async () => {
    await enter(page, 'vocab');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, st = D.STM.vocab, G = window.__ilha.genSimon, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }, go = (x, z) => { D.P.set(x, 0, z); run(12); };
      D.timeScale = .01; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click(); D.startMode(st, st.modes[1]); const C = D.CH, out = {};
      let q; do q = G(3); while (q.trick || q.steps[0].k !== 'jump' || q.steps[1].k !== 'color'); D.simonLoad(q); C.phase = 'play';
      const right = C.mats.find(m => m.k === q.steps[1].c), wrong = C.mats.find(m => m.k !== q.steps[1].c);
      const clear = D.L2W(st, 4, 0); go(right.x, right.z); run(60); out.early = [C.si, C.hearts, C.locked]; go(clear.x, clear.z);
      for (let i = 0; i < q.steps[0].n; i++) { D.jump(); run(60); } out.afterJumps = C.si;
      go(wrong.x, wrong.z); run(60); out.wrongMat = [C.hearts, C.locked];
      do q = G(2); while (!q.trick || q.steps[0].k !== 'jump'); D.simonLoad(q); C.phase = 'play'; go(clear.x, clear.z); const h0 = C.hearts; for (let i = 0; i < q.steps[0].n; i++) { D.jump(); run(60); } out.obeyedTrick = [h0 - C.hearts, C.locked, /mestre/i.test(q.text)];
      do q = G(2); while (!q.trick); D.simonLoad(q); C.phase = 'play'; const f0 = C.first, h1 = C.hearts; run(60 * 7); out.ignoredTrick = [C.first - f0, h1 - C.hearts];
      /* already standing on a circle when the order comes: it is neither obeying a trick nor stepping on the wrong one */
      const col = c => { let o; do o = G(2); while (!o.trick || o.steps[0].k !== 'color'); o.steps[0].c = c; return o; }, other = C.mats.find(m => m !== right && m !== wrong);
      go(right.x, right.z); q = col(right.k); D.simonLoad(q); C.phase = 'play'; const f1 = C.first, h3 = C.hearts; run(60 * 7); out.trickOnMat = [C.first - f1, h3 - C.hearts];
      q = col(right.k); D.simonLoad(q); C.phase = 'play'; const h4 = C.hearts; run(30); go(clear.x, clear.z); go(right.x, right.z); run(40); out.trickReentered = [h4 - C.hearts, C.locked];
      do q = G(1); while (q.steps[0].k !== 'color'); q.steps[0].c = other.k; go(wrong.x, wrong.z); D.simonLoad(q); C.phase = 'play'; const h5 = C.hearts; run(120); out.stoodOnOther = [h5 - C.hearts, C.locked];
      go(clear.x, clear.z); go(wrong.x, wrong.z); run(60); out.steppedOnOther = [h5 - C.hearts, C.locked];
      do q = G(1); while (q.steps[0].k !== 'color'); q.steps[0].c = right.k; go(right.x, right.z); D.simonLoad(q); C.phase = 'play'; const f2 = C.first; run(40); out.alreadyOnRight = C.first - f2;
      do q = G(1); while (q.steps[0].k !== 'hide'); D.simonLoad(q); C.phase = 'play'; const open = D.L2W(st, 4, 0), h2 = C.hearts; go(open.x, open.z); run(60 * 8); out.seen = h2 - C.hearts;
      return out;
    });
    eq(r, { early: [0, 3, false], afterJumps: 1, wrongMat: [2, true], obeyedTrick: [1, true, false], ignoredTrick: [1, 0], trickOnMat: [1, 0], trickReentered: [1, true], stoodOnOther: [0, false], steppedOnOther: [1, true], alreadyOnRight: 1, seen: 1 }, 'master game rules');
    await page.waitForTimeout(500); await page.evaluate(() => { __ilhaDebug.timeScale = 1; __ilhaDebug.flushFin(); __ilhaDebug.closeSheet(); if (__ilhaDebug.CH) document.querySelector('#m-quit').click(); });
  });

  await test('no script errors during the whole run', async () => { eq(errors, [], 'errors'); });

  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
