// Website test: runs the whole site (static files + API, see startSite) and
// drives it like players would over several (faked) days: loading a FireRed
// ROM (wrong files are refused, both v1.0 and v1.1 are patched), creating a
// trainer, one battle per day, win / loss / abandoned battles, streaks, the
// hall of fame, the recovery code on another browser, practice runs, the phone
// layout and the error screen. Screenshots go to tests/output/site-*.png.
//
// Needs the original ROMs that scripts/build-patches.sh builds in .retail/.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, ADMIN_TOKEN, startSite, launchBrowser, sleep, press, getStatus, waitFor, startRedBattle, forceWin, forceLoss,
} from './lib.mjs';
import { readParty } from './party.mjs';

const OUT = new URL('./output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const ROM_V10 = join(ROOT, '.retail/pokefirered/pokefirered.gba');
const ROM_V11 = join(ROOT, '.retail/pokefirered/pokefirered_rev1.gba');
if (!existsSync(ROM_V10) || !existsSync(ROM_V11)) {
  console.error('Original FireRed ROMs missing: run scripts/build-patches.sh first.');
  process.exit(1);
}

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

const DAY1 = '2026-10-11', DAY2 = '2026-10-12', DAY3 = '2026-10-13', DAY5 = '2026-10-15';

// Sets the clock for the page and (through X-Test-Now) for the server.
async function setTime(context, page, day, time = '10:00:00') {
  const iso = `${day}T${time}Z`;
  await context.setExtraHTTPHeaders({ 'X-Test-Now': iso });
  await page.clock.setFixedTime(new Date(iso));
}

const state = (page) => page.evaluate(() => document.querySelector('.app').dataset.state);
const waitState = (page, wanted, timeout = 30000) => page.waitForFunction((w) => document.querySelector('.app').dataset.state === w, wanted, { timeout });
const shown = (page) => page.evaluate(() => ({
  wins: document.getElementById('stat-wins').textContent,
  losses: document.getElementById('stat-losses').textContent,
  winStreak: document.getElementById('stat-win-streak').textContent,
  dayStreak: document.getElementById('stat-day-streak').textContent,
  canPlay: !document.getElementById('play').hidden,
  played: document.getElementById('played').hidden ? null : document.getElementById('played-result').textContent,
  next: document.getElementById('played-next').textContent,
  note: document.getElementById('title-note').hidden ? null : document.getElementById('title-note').textContent,
}));
const statLine = (s) => `${s.wins}W ${s.losses}L, win streak ${s.winStreak}, day streak ${s.dayStreak}`;
const fame = (page) => page.evaluate(() => ({
  summary: document.getElementById('fame-summary').textContent,
  today: [...document.querySelectorAll('#fame-today li:not(.fame-empty)')].map((li) => ({ name: li.querySelector('.fame-name').textContent, me: li.classList.contains('is-me') })),
  wins: [...document.querySelectorAll('#fame-wins li:not(.fame-empty) .fame-name')].map((el) => el.textContent),
}));
const team = async (page) => JSON.stringify(readParty((await getStatus(page)).mem).party.map((m) => m.species));
const todayOnServer = (page) => page.evaluate(async () => (await (await fetch('api/me', { headers: { Authorization: `Bearer ${localStorage.getItem('dailyred-code')}` } })).json()).today.status);

async function loadRom(page, path) {
  await page.setInputFiles('#rom-file', path);
}

async function joinAs(page, name) {
  await waitState(page, 'join');
  await page.fill('#join-name', name);
  await page.click('#join-form button[type=submit]');
  await waitState(page, 'title');
}

// The test helpers talk to window.emu; point it at the site's emulator.
async function attach(page) {
  await waitState(page, 'playing', 60000);
  await page.evaluate(() => { window.emu = window.dailyRed.emulator; });
  return waitFor(page, (s) => s.inOverworld, { what: 'overworld', timeoutMs: 30000 });
}

// Presses A through the end of the battle and the closing messages until the
// site has closed the game and is back on the title card.
async function finishDailyGame(page, shotPrefix) {
  for (let i = 0; i < 120; i++) {
    if ((await state(page)) === 'title') return true;
    if (shotPrefix && i % 3 === 0) await page.locator('canvas').first().screenshot({ path: `${OUT}/${shotPrefix}-${String(i).padStart(3, '0')}.png` }).catch(() => {});
    await press(page, 'a').catch(() => {});
    await sleep(400);
  }
  return false;
}

// Every visible child of a card lies inside it (nothing cut off).
const fitsInCard = (page, selector) => page.evaluate((sel) => {
  const card = document.querySelector(sel).getBoundingClientRect();
  return [...document.querySelectorAll(`${sel} > :not(.snow):not([hidden]):not(.visually-hidden)`)].every((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= card.top - 1 && r.bottom <= card.bottom + 1 && r.left >= card.left - 1 && r.right <= card.right + 1;
  });
}, selector);

const site = await startSite();
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // --- Day 1: a fresh visitor loads a ROM and creates a trainer ----------------
  await setTime(context, page, DAY1);
  await page.goto(site.url);
  await waitState(page, 'rom');
  await page.screenshot({ path: `${OUT}/site-rom.png`, fullPage: true });
  check(true, 'a new visitor is asked for their FireRed ROM');
  check(!(await page.locator('#change-rom').isVisible()), 'no Change ROM button before a ROM is loaded');
  await page.waitForFunction(() => /No one has battled RED/.test(document.getElementById('fame-summary').textContent));
  check(true, 'the hall of fame is shown before a ROM is loaded');
  const footer = await page.evaluate(() => document.querySelector('.footer')?.textContent || '');
  check(/unofficial fan project/.test(footer) && /not affiliated|isn't affiliated/.test(footer), 'footer shows the fan-project disclaimer');
  const credit = await page.evaluate(() => document.querySelector('.footer .credit a')?.href);
  check(credit === 'https://github.com/amoi-builds/dailyred', `footer credits the original project (${credit})`);
  const served = await page.evaluate(async () => ({
    licenses: (await fetch('licenses.txt')).status,
    rom: (await fetch('game/dailyred.gba.gz')).status,
    sprite: (await fetch('game/red.png')).status,
  }));
  check(served.licenses === 200, `footer links to licenses.txt (status ${served.licenses})`);
  check(served.rom === 404 && served.sprite === 404, `the site serves no ROM and no game art (status ${served.rom}, ${served.sprite})`);

  const fake = new Uint8Array(1 << 20);
  fake.set(new TextEncoder().encode('BPGE'), 0xAC);
  writeFileSync(join(OUT, 'leafgreen.gba'), fake);
  await loadRom(page, join(OUT, 'leafgreen.gba'));
  await page.waitForFunction(() => !document.getElementById('rom-error').hidden);
  const romError = await page.locator('#rom-error').textContent();
  check(romError.includes('LeafGreen') && (await state(page)) === 'rom', `a LeafGreen ROM is refused ("${romError}")`);
  writeFileSync(join(OUT, 'notarom.gba'), new Uint8Array(4096).fill(7));
  await loadRom(page, join(OUT, 'notarom.gba'));
  await page.waitForFunction(() => /isn't a Pokémon FireRed ROM/.test(document.getElementById('rom-error').textContent));
  check(true, 'a file that is not a ROM is refused');

  await loadRom(page, ROM_V10);
  await waitState(page, 'join');
  await page.screenshot({ path: `${OUT}/site-join.png`, fullPage: true });
  check(true, 'FireRed v1.0 is accepted and patched');

  await page.fill('#join-name', 'A');
  await page.click('#join-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('join-error').hidden);
  check((await state(page)) === 'join', `a one-letter name is refused ("${await page.locator('#join-error').textContent()}")`);
  await joinAs(page, 'Alice');
  const code = await page.evaluate(() => localStorage.getItem('dailyred-code'));
  check(await page.locator('#code-box').isVisible() && (await page.locator('#code-text').textContent()) === code, 'after joining, the recovery code is shown');
  const trainer = await page.locator('.trainer-line').textContent();
  check(/^Trainer Alice #[0-9A-Z]{6}$/.test(trainer.trim()), `trainer card: "${trainer.trim()}"`);
  await page.screenshot({ path: `${OUT}/site-title.png`, fullPage: true });
  let s = await shown(page);
  check(s.canPlay && s.wins === '0' && s.losses === '0' && s.winStreak === '0' && s.dayStreak === '0', `new trainer sees Play and zeroed stats (${statLine(s)})`);
  check(!(await page.locator('#play-again').isVisible()), 'no Play again before the day\'s battle');
  check(await page.evaluate(() => document.getElementById('red-sprite').naturalWidth === 64), "RED's sprite is drawn from the ROM");
  check(!(await page.locator('.pad').isVisible()), 'touch controls are hidden on desktop');

  // --- Day 1: a win ----------------------------------------------------------------
  await page.click('#play');
  await attach(page);
  const box = await page.locator('canvas').boundingBox();
  check(Math.round(box.width) === 720 && Math.round(box.height) === 480, `game screen is 720x480 on desktop (got ${box.width}x${box.height})`);
  const team1 = await team(page);

  await startRedBattle(page);
  await sleep(1500);
  check((await todayOnServer(page)) === 'running', 'once the battle starts, the server counts today as played');
  await forceWin(page);
  check(await finishDailyGame(page, 'site-win'), 'after a win the site closes the game and returns to the title card');
  s = await shown(page);
  check(s.wins === '1' && s.losses === '0' && s.winStreak === '1' && s.dayStreak === '1', `win recorded (${statLine(s)})`);
  check(!s.canPlay && s.played === 'You beat RED today!' && /^Next ranked battle in \d\d:\d\d:\d\d$/.test(s.next), `no Play button; shows "${s.played}" / "${s.next}"`);
  await page.waitForFunction(() => document.querySelectorAll('#fame-today li.is-me').length === 1);
  let f = await fame(page);
  check(f.today[0]?.name === 'Alice' && f.today[0].me && f.summary === 'Today 1 of 1 trainer beat RED.', `hall of fame: "${f.summary}", Alice highlighted`);
  await page.screenshot({ path: `${OUT}/site-played.png`, fullPage: true });

  // Rematches: as many as you like with the day's team, never counted.
  check(await page.locator('#play-again').isVisible(), "after the day's battle, Play again is offered");
  await page.setViewportSize({ width: 390, height: 844 });
  check(await fitsInCard(page, '.card-title'), 'the title card with Play again fits a phone-sized screen');
  await page.screenshot({ path: `${OUT}/site-phone-played.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [n, outcome] of [[1, forceLoss], [2, forceWin]]) {
    await page.click('#play-again');
    await attach(page);
    if (n === 1) check((await team(page)) === team1, "a rematch gets the day's team");
    await startRedBattle(page);
    await outcome(page);
    check(await finishDailyGame(page, `site-rematch-${n}`), `after rematch ${n} the site returns to the title card`);
  }
  s = await shown(page);
  check(s.wins === '1' && s.losses === '0' && s.played === 'You beat RED today!', `rematches don't change the stats (${statLine(s)})`);
  check((await todayOnServer(page)) === 'won', "the server still has the day's win");
  f = await fame(page);
  check(f.today.length === 1 && f.summary === 'Today 1 of 1 trainer beat RED.', 'rematches stay out of the Hall of Fame');

  // --- Reports and the admin page --------------------------------------------------
  // Zed, made through the API, "wins" in no time: Alice reports him.
  const apiPost = async (path, body, auth) => (await fetch(`${site.url}/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Now': `${DAY1}T10:30:00Z`, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  })).json();
  const zed = await apiPost('players', { name: 'Zed' });
  await apiPost('battles/start', { day: DAY1, run: 'zed-run-0001' }, zed.code);
  await apiPost('battles/result', { day: DAY1, won: true, run: 'zed-run-0001' }, zed.code);
  await page.reload();
  await waitState(page, 'title');
  await page.waitForFunction(() => document.querySelectorAll('#fame-today li:not(.fame-empty)').length === 2);
  const flags = await page.evaluate(() => [...document.querySelectorAll('#fame-today li')].map((li) => ({ name: li.querySelector('.fame-name').textContent, flag: Boolean(li.querySelector('.fame-report')) })));
  check(flags.find((r) => r.name === 'Zed')?.flag && !flags.find((r) => r.name === 'Alice')?.flag, 'a report flag next to other trainers, not next to yourself');
  const zedFlag = `#fame-today .fame-report[data-player="${zed.player.id}"]`;
  await page.click(zedFlag);
  await page.waitForSelector('#report-dialog[open]');
  check((await page.locator('#report-title').textContent()) === `Report Zed #${zed.player.id}`, 'the report dialog names the trainer');
  await page.fill('#report-note', 'Won in a few seconds');
  await page.screenshot({ path: `${OUT}/site-report.png` });
  await page.click('#report-send');
  await page.waitForFunction(() => !document.getElementById('report-dialog').open, null, { timeout: 5000 });
  check(await page.locator(zedFlag).isDisabled(), 'after reporting, the flag is greyed out');

  // A site problem, typed while a rematch is running.
  await page.click('#play-again');
  await attach(page);
  await page.click('#report-problem');
  await page.waitForSelector('#report-dialog[open]');
  await page.locator('#report-note').pressSequentially('The game is slow on my laptop', { delay: 20 });
  check((await page.inputValue('#report-note')) === 'The game is slow on my laptop', 'typing a problem report works while the game is running');
  await page.click('#report-send');
  await page.waitForFunction(() => !document.getElementById('report-dialog').open, null, { timeout: 5000 });
  check(true, 'the problem report is sent');
  await page.reload(); // leaving a rematch is fine: it isn't reported
  await waitState(page, 'title');

  const adminPage = await context.newPage();
  await adminPage.goto(`${site.url}/admin.html`);
  await adminPage.fill('#token', 'wrong');
  await adminPage.click('#login button[type=submit]');
  await adminPage.waitForFunction(() => !document.getElementById('login-error').hidden);
  check(await adminPage.locator('#panel').isHidden(), 'the admin page refuses a wrong token');
  await adminPage.fill('#token', ADMIN_TOKEN);
  await adminPage.click('#login button[type=submit]');
  await adminPage.waitForFunction(() => !document.getElementById('panel').hidden && document.querySelectorAll('.admin-card').length > 0);
  const cards = await adminPage.evaluate(() => [...document.querySelectorAll('.admin-card')].map((c) => c.textContent));
  check(cards.length === 2
    && cards.some((t) => /Suspicious result/.test(t) && /Zed/.test(t) && /Won in a few seconds/.test(t) && /Alice/.test(t))
    && cards.some((t) => /Site problem/.test(t) && /slow on my laptop/.test(t) && /"state": "playing"/.test(t)),
  'the admin page lists both reports with their details');
  check((await adminPage.locator('.admin-battles .is-suspicious').count()) === 1, "Zed's instant win is highlighted");
  await adminPage.screenshot({ path: `${OUT}/site-admin.png`, fullPage: true });
  await adminPage.click('text=Hide from the Hall of Fame');
  await adminPage.waitForFunction(() => /Zed/.test(document.getElementById('hidden').textContent));
  check(true, 'the admin hides Zed from the Hall of Fame');
  await adminPage.close();
  await page.reload();
  await waitState(page, 'title');
  await page.waitForFunction(() => /Today 1 of 1 trainer/.test(document.getElementById('fame-summary').textContent));
  f = await fame(page);
  check(f.today.length === 1 && f.today[0].name === 'Alice', 'Zed is gone from the Hall of Fame');

  await page.reload();
  await waitState(page, 'title');
  s = await shown(page);
  check(!s.canPlay && s.wins === '1', 'reloading: the ROM comes back from the browser, the day stays locked');

  // Same team for everyone today: Bob, in another browser with FireRed v1.1.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await setTime(other, otherPage, DAY1, '22:00:00');
  await otherPage.goto(site.url);
  await waitState(otherPage, 'rom');
  await loadRom(otherPage, ROM_V11);
  await joinAs(otherPage, 'Bob');
  check(true, 'FireRed v1.1 is accepted and patched');
  await otherPage.click('#play');
  await attach(otherPage);
  check((await team(otherPage)) === team1, 'everyone gets the same team on the same day');
  await other.close();

  // --- Day 2: a loss ---------------------------------------------------------------
  await setTime(context, page, DAY2);
  await page.reload();
  await waitState(page, 'title');
  s = await shown(page);
  check(s.canPlay && s.winStreak === '1' && s.dayStreak === '1', `next day: Play is back, streaks kept (${statLine(s)})`);
  await page.click('#play');
  await attach(page);
  check((await team(page)) !== team1, 'a new day brings a new team');
  await startRedBattle(page);
  await forceLoss(page);
  check(await finishDailyGame(page, 'site-loss'), 'after a loss the site closes the game and returns to the title card');
  s = await shown(page);
  check(s.wins === '1' && s.losses === '1' && s.winStreak === '0' && s.dayStreak === '2', `loss recorded (${statLine(s)})`);
  check(s.played === 'RED won today.', `shows "${s.played}"`);

  // --- Day 3: leave in the middle of the battle -> a loss ---------------------------
  await setTime(context, page, DAY3);
  await page.reload();
  await waitState(page, 'title');
  await page.click('#play');
  await attach(page);
  await startRedBattle(page);
  await sleep(1500);
  // Opening the site on another device meanwhile doesn't end the battle.
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await setTime(second, secondPage, DAY3, '10:05:00');
  await secondPage.goto(site.url);
  await waitState(secondPage, 'rom');
  await loadRom(secondPage, ROM_V10);
  await waitState(secondPage, 'join');
  await secondPage.click('#toggle-restore');
  await secondPage.fill('#restore-code', code.replace(/-/g, ' '));
  await secondPage.click('#restore-form button[type=submit]');
  await waitState(secondPage, 'title');
  s = await shown(secondPage);
  check(!s.canPlay && /under way in another tab/.test(s.note ?? ''), `another device shows the battle as under way ("${s.note}")`);
  check((await todayOnServer(page)) === 'running', "and the battle isn't forfeited");
  await second.close();
  await page.reload();
  await waitState(page, 'title');
  s = await shown(page);
  check(s.losses === '2' && s.dayStreak === '3' && !s.canPlay && s.played === 'RED won today.', `reloading mid-battle counts as a loss (${statLine(s)})`);

  // --- Day 5: a missed day resets the streaks -------------------------------------
  await setTime(context, page, DAY5);
  await page.reload();
  await waitState(page, 'title');
  s = await shown(page);
  check(s.canPlay && s.winStreak === '0' && s.dayStreak === '0' && s.wins === '1' && s.losses === '2', `missing a day resets the streaks (${statLine(s)})`);

  // Practice runs (?seed=) ignore the daily limit and never reach the server.
  await page.goto(`${site.url}/?seed=777`);
  await waitState(page, 'title');
  s = await shown(page);
  check(s.canPlay && s.note === "Practice run: results aren't saved." && !(await page.locator('#stats').isVisible()), 'practice run: Play is available, with a note');
  check(!(await page.locator('#fame').isVisible()) && !(await page.locator('#trainer').isVisible()), 'practice run: no hall of fame or trainer card');
  await page.click('#play');
  await attach(page);
  await startRedBattle(page);
  await sleep(1500);
  check((await todayOnServer(page)) === 'open', 'practice battles are not recorded');
  check(errors.length === 0, `no page errors (${errors.join('; ') || 'none'})`);
  await context.close();

  // --- Alice on another device, with her recovery code ------------------------------
  const laptop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const laptopPage = await laptop.newPage();
  await setTime(laptop, laptopPage, DAY5, '12:00:00');
  await laptopPage.goto(site.url);
  await waitState(laptopPage, 'rom');
  await loadRom(laptopPage, ROM_V10);
  await waitState(laptopPage, 'join');
  await laptopPage.click('#toggle-restore');
  await laptopPage.fill('#restore-code', 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  await laptopPage.click('#restore-form button[type=submit]');
  await laptopPage.waitForFunction(() => !document.getElementById('join-error').hidden);
  check(/doesn't match/.test(await laptopPage.locator('#join-error').textContent()), 'a wrong recovery code is refused');
  await laptopPage.fill('#restore-code', code.toLowerCase());
  await laptopPage.click('#restore-form button[type=submit]');
  await waitState(laptopPage, 'title');
  s = await shown(laptopPage);
  check(s.wins === '1' && s.losses === '2' && /Alice/.test(await laptopPage.locator('.trainer-line').textContent()), `the recovery code brings Alice to another browser (${statLine(s)})`);
  await laptopPage.click('#change-rom');
  await waitState(laptopPage, 'rom');
  await loadRom(laptopPage, ROM_V11);
  await waitState(laptopPage, 'title');
  check(true, 'Change ROM: another ROM can be loaded, and the trainer stays');
  await laptop.close();

  // --- Phone: layout and touch controls --------------------------------------------
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const phone = await phoneContext.newPage();
  await setTime(phoneContext, phone, DAY5, '13:00:00');
  await phone.goto(site.url);
  await waitState(phone, 'rom');
  // Viewport-only screenshots: a fullPage capture resizes the viewport, which
  // makes Chromium drop the emulated touch pointer for the rest of the page.
  await phone.screenshot({ path: `${OUT}/site-phone-rom.png` });
  check(await fitsInCard(phone, '.card-rom'), 'the ROM card fits inside the phone-sized screen');
  await loadRom(phone, ROM_V10);
  await waitState(phone, 'join');
  await phone.screenshot({ path: `${OUT}/site-phone-join.png` });
  check(await fitsInCard(phone, '.card-join'), 'the trainer-name card fits inside the phone-sized screen');
  await joinAs(phone, 'Carol');
  await phone.screenshot({ path: `${OUT}/site-phone-title.png` });
  check(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'no horizontal scrolling on a phone');
  check(await fitsInCard(phone, '.card-title'), 'the title card fits inside the phone-sized screen');
  check(await phone.locator('.pad').isVisible(), 'touch controls are shown on a phone');
  await phone.click('#play');
  await attach(phone);
  await sleep(1500);
  const startY = (await getStatus(phone)).y;
  const dpad = await phone.locator('.dpad').boundingBox();
  await phone.mouse.move(dpad.x + dpad.width / 2, dpad.y + 10); // top arm of the d-pad
  await phone.mouse.down();
  await sleep(600);
  await phone.mouse.up();
  await sleep(600);
  const endY = (await getStatus(phone)).y;
  check(endY < startY, `touch d-pad moves the player (y ${startY} -> ${endY})`);
  await phone.screenshot({ path: `${OUT}/site-phone-playing.png` });
  await phoneContext.close();

  // --- Failed downloads show the error card, and Try again recovers ----------------
  const brokenContext = await browser.newContext();
  const broken = await brokenContext.newPage();
  await setTime(brokenContext, broken, DAY5, '14:00:00');
  await broken.route('**/game/firered-v1.0.bps.gz', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await broken.route('**/vendor/mgba_libretro.wasm', (route) => route.fulfill({ status: 404, body: 'missing' }));
  await broken.goto(site.url);
  await waitState(broken, 'rom');
  await loadRom(broken, ROM_V10);
  await waitState(broken, 'error');
  let message = await broken.locator('#error-text').textContent();
  check(message.includes('HTTP 404'), `a failed patch download shows an error ("${message}")`);
  await broken.unroute('**/game/firered-v1.0.bps.gz');
  await broken.click('#retry');
  await waitState(broken, 'join');
  check(true, 'Try again recovers (the ROM was kept)');
  await joinAs(broken, 'Dave');
  await broken.click('#play');
  await waitState(broken, 'error');
  message = await broken.locator('#error-text').textContent();
  check(message.includes('HTTP 404'), `a failed emulator download shows an error ("${message}")`);
  await broken.unroute('**/vendor/mgba_libretro.wasm');
  await broken.click('#retry');
  await attach(broken);
  check(true, 'Try again starts the game after the error');
  await brokenContext.close();
} catch (err) {
  failures++;
  console.log('FAIL ', err.stack || err.message);
} finally {
  await browser.close();
  site.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
