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
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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
  /* how many games each station offers (three of them also have the kart) */
  const MODES = { contas: [0, 1, 2], ordem: [0, 1, 2], vocab: [0, 1], n10: [0, 1], formas: [0, 1], dinheiro: [0, 1], n100: [0, 1, 2], medidas: [0, 1] };

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
      const val = s => { const m = String(s).match(/^(\d+) ([+−]) (\d+)$/); return m ? (m[2] === '+' ? +m[1] + +m[3] : +m[1] - +m[3]) : NaN; };
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
        { const q = G.genShootArith(L), ok = q.items.filter(x => x.ok); if (ok.length < 2 || ok.some(x => val(x.label) !== q.T) || q.items.some(x => !x.ok && val(x.label) === q.T) || q.items.some(x => isNaN(val(x.label))) || new Set(q.items.map(x => x.label)).size !== q.items.length) note('genShootArith L' + L, 'balloons', q); }
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

  await test('all 19 game modes start at levels 1, 2 and 3 and run for a moment', async () => {
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
    eq([r.verb, r.locked, r.dTotal, r.dFirst, r.dCoins, r.dSkill], ['jump', true, 1, 1, 2, 1], 'verb, locked, total, first, coins, skill count');
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
    await cycle(8); const g0 = await geo(); await cycle(25); const g1 = await geo();
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
    eq(await p.evaluate(() => { const S = __ilhaDebug.S(); return [S.name, S.coins, S.st.contas.level, S.trophies.contas, S.trophies.formas, typeof S.sk, document.querySelector('#ov').hidden]; }), ['Antigo', 12, 2, 2, 4, 'object', true], 'old save (its gold cup, stored as 3, becomes 4)');
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
    eq([after.title, after.coins - before.coins, after.stars - before.stars, after.trophy], ['Vamos treinar mais!', 1, 0, 0], 'title, coins (1 for the late right answer), stars, trophy');
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
        else if (C.type === 'shoot') { const b = C.balloons.find(b => b.alive && b.it.ok); if (b) { D.yaw = Math.atan2(D.P.x - b.x, D.P.z - b.z); run(24); D.fire(); for (let i = 0; i < 90 && b.alive; i++) D.step(1 / 60); } }
        else if (C.type === 'floor') { if (C.phase === 'read') C.phase = 'play'; if (C.phase !== 'play') return false; const t = C.tiles.find(t => t.ok); go(t.p.cx, t.p.cz, 1); run(20); document.querySelector('#b-sure').click(); run(3); }
        else if (C.type === 'kart') { if (C.phase === 'ready') C.phase = 'go'; const g = C.gates[C.idx]; C.v = 8; if (g) C.lat = (C.qs[C.idx].ans - 1) * 4; D.P.x = (g ? g.x : C.endX) - .3; run(6); }
        else if (C.type === 'simon') { if (C.phase === 'read') C.phase = 'play'; if (C.phase !== 'play') return false; const k = C.q.k;
          if (k === 'cima') { const pl = D.PLATS.find(p => p.bloco); go(pl.cx, pl.cz, 1.3); run(20); }
          else { const w = { dentro: [11, 7], embaixo: [2, -6], perto: [10, -5.5], longe: [-4, 8], entre: [2, 8], fora: [11, 3] }[k], p = L(w[0], w[1]); go(p.x, p.z); }
          document.querySelector('#b-sure').click(); run(3); }
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
      const out = { missed: [...(window.__missed || [])], stars: document.querySelectorAll('.bigstars span:not(.off)').length, line: document.querySelector('.result p').textContent, level: S.st[id].level, trophy: S.trophies[id] || 0 }; __ilhaDebug.closeSheet(); return out; }, id);
  }

  await test('a round played without mistakes earns 3 stars in every game mode, at every level', async () => {
    const p = await open(1024, 768); const bad = [];
    await p.evaluate(() => { __ilhaDebug.autoQual = false; __ilhaDebug.setQuality(0); });
    for (const id of STATION_IDS) for (const mi of MODES[id]) {
      const isAct = await p.evaluate(([id, mi]) => __ilhaDebug.STM[id].modes[mi].k === 'act', [id, mi]);
      for (const level of [1, 2, 3]) for (let rep = 0; rep < (isAct ? 3 : 1); rep++) {
        const r = await perfectRound(p, id, mi, level);
        if (r.error || r.stars !== 3 || !/acertou (\d+) de \1 /.test(r.line)) bad.push(`${id} mode ${mi} level ${level}: ${JSON.stringify(r)}`);
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
    await enter(page, 'ordem');
    const r = await page.evaluate(() => {
      const D = __ilhaDebug, S = D.S(), st = D.STM.ordem, run = n => { for (let i = 0; i < n; i++) D.step(1 / 60); }; D.timeScale = .01; D.flushFin(); D.closeSheet(); if (D.CH) document.querySelector('#m-quit').click();
      const t0 = S.st.ordem ? S.st.ordem.total : 0, c0 = S.coins; D.startMode(st, st.modes[2]); const C = D.CH, far = Math.hypot(D.P.x - st.c.x, D.P.z - st.c.z) > 100, stays = (run(30), D.P.x);
      C.phase = 'go'; const pass = lane => { const g = C.gates[C.idx]; C.v = 8; C.lat = (lane - 1) * 4; D.P.x = g.x - .3; run(6); };
      const q0 = C.qs[0]; pass((q0.ans + 1) % 3); const afterWrong = [C.idx, C.first, S.coins - c0]; pass(C.qs[1].ans); const afterRight = [C.idx, C.first, S.coins - c0];
      for (let k = 2; k < 5; k++) pass(C.qs[k].ans); C.v = 8; D.P.x = C.endX - .3; run(6);
      return { far, waitsForStart: Math.abs(stays - (C.x0 + 8)) < .01, afterWrong, afterRight, records: S.st.ordem.total - t0, ended: !D.CH, home: Math.hypot(D.P.x - st.c.x, D.P.z - st.c.z) < 20 };
    });
    eq(r, { far: true, waitsForStart: true, afterWrong: [1, 0, 0], afterRight: [2, 1, 2], records: 5, ended: true, home: true }, 'kart race');
    await page.waitForSelector('.result h2', { timeout: 6000 });
    eq(await page.evaluate(() => document.querySelector('.result p').textContent), 'Kart dos Números: acertou 4 de 5 de primeira.', 'result line');
    await page.evaluate(() => { __ilhaDebug.timeScale = 1; __ilhaDebug.closeSheet(); });
  });

  await test('shop: a football shirt can be bought and worn, and its shorts come with it', async () => {
    const p = await open(1024, 768);
    await p.evaluate(() => { const D = __ilhaDebug; D.S().coins = 40; D.P.set(0, 0, -5); for (let i = 0; i < 3; i++) D.step(1 / 60); });
    await p.waitForSelector('#b-act:not([hidden])'); await p.click('#b-act', { force: true }); await p.click('.tab[data-t="kit"]');
    eq(await p.evaluate(() => [document.querySelectorAll('.item').length, document.querySelectorAll('.item img.jr').length]), [27, 27], 'shirts on offer, each with its picture');
    await p.click('.item[data-k="bra"]'); await p.waitForSelector('.quiz .btn.big'); await p.click('.quiz .btn.big[data-v="10"]');
    const r = await p.evaluate(() => { const D = __ilhaDebug, S = D.S(); let chest = null; D.scene.traverse(o => { if (o.isMesh && Array.isArray(o.material) && o.material[5] && o.material[5].map && !o.userData.head) chest = o; });
      return { coins: S.coins, shirt: S.look.shirt, owned: S.owned.includes('kit:bra'), chest: !!chest, using: document.querySelector('.item[data-k="bra"]').classList.contains('eq') }; });
    eq(r, { coins: 10, shirt: 'bra', owned: true, chest: true, using: true }, 'after buying the Brasil shirt for 30 with 40 coins');
    await p.context().close();
  });

  await test('no script errors during the whole run', async () => { eq(errors, [], 'errors'); });

  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
