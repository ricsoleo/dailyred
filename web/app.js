// Website controller. First visit: load your FireRed ROM (patched into Daily
// Red in the browser, see rom-store.js), then pick a trainer name (the server
// gives you an ID and a recovery code, see api.js). Then the daily title card
// (RED, your stats, Play), the emulator, the hall of fame, and the toolbar and
// touch controls. All game behaviour lives in the ROM; this file starts it
// with the day's seed, reports the battle's start and result to the server,
// and shows what the server says.
import { Nostalgist } from './vendor/nostalgist.js';
import { loadCore } from './game-files.js';
import { injectConfig, parseSeed } from './rom-config.js';
import { createGameLink, PHASE, RESULT } from './game-link.js';
import { loadSavedRom, saveRom, forgetRom, identifyRom, patchRom, RomError } from './rom-store.js';
import { redSpriteUrl } from './red-sprite.js';
import {
  savedCode, saveCode, normalizeCode, serverNow, createPlayer, getMe, startBattle, sendResult, getHallOfFame,
} from './api.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const screen = $('screen');
const ui = {
  play: $('play'),
  playAgain: $('play-again'),
  retry: $('retry'),
  sound: $('sound'),
  fullscreen: $('fullscreen'),
  redSprite: $('red-sprite'),
  stats: $('stats'),
  wins: $('stat-wins'),
  losses: $('stat-losses'),
  winStreak: $('stat-win-streak'),
  dayStreak: $('stat-day-streak'),
  played: $('played'),
  playedResult: $('played-result'),
  playedNext: $('played-next'),
  titleNote: $('title-note'),
  loadingText: $('loading-text'),
  loadingDetail: $('loading-detail'),
  meter: $('meter'),
  errorText: $('error-text'),
  romFile: $('rom-file'),
  romError: $('rom-error'),
  joinForm: $('join-form'),
  joinName: $('join-name'),
  restoreForm: $('restore-form'),
  restoreCode: $('restore-code'),
  toggleRestore: $('toggle-restore'),
  joinError: $('join-error'),
  trainer: $('trainer'),
  trainerName: $('trainer-name'),
  trainerId: $('trainer-id'),
  showCode: $('show-code'),
  changeRom: $('change-rom'),
  codeBox: $('code-box'),
  codeNote: $('code-note'),
  codeText: $('code-text'),
  copyCode: $('copy-code'),
  fame: $('fame'),
  fameSummary: $('fame-summary'),
  fameToday: $('fame-today'),
  fameWins: $('fame-wins'),
  fameStreaks: $('fame-streaks'),
};

// sessionStorage can throw when storage is blocked; the site works without it.
const session = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* not remembered */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* nothing kept */ } },
};

// While this tab has a battle the server knows about but hasn't got the result
// of, it's noted here ({day, run, won}). sessionStorage belongs to the tab and
// survives a reload, so a reload can settle it: as a loss if the battle was
// still on, or with the result if it was known but couldn't be sent.
const BATTLE_KEY = 'dailyred-battle';

function battleNote() {
  try {
    return JSON.parse(session.get(BATTLE_KEY));
  } catch {
    return null;
  }
}

const newRunId = () => crypto.randomUUID?.()
  ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// ?seed=123 starts a practice run with that team, for testing: nothing is
// sent to the server, there's no daily limit, and the game keeps dealing new teams.
const practiceSeed = parseSeed(new URLSearchParams(location.search).get('seed'));

let manifest = null; // game/patches.json
let rom = null;      // the Daily Red ROM, patched from the player's own
let me = null;       // { player, today } from the server
let run = null;      // the day's battle being played: { day, id, battleSeen, start, result }
let rematching = false; // a rematch with the day's team is being played (never reported)
let emu = null;
let readGame = null;
let pollTimer = null;
let muted = session.get('dailyred-muted') === '1';
let starting = false;
let retryAction = null;
let refreshingDay = false;
let joining = false;

// RetroArch opens a Web Audio context for each emulator and never closes it,
// so a restart would leave one running (and browsers cap how many a page can
// have). Track the contexts the emulator creates and close them on exit.
const audioContexts = [];
const NativeAudioContext = window.AudioContext;
if (NativeAudioContext) {
  window.AudioContext = class extends NativeAudioContext {
    constructor(...args) {
      super(...args);
      audioContexts.push(this);
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const megabytes = (n) => (n / 1048576).toFixed(1);

function setState(state) {
  app.dataset.state = state;
  const playing = state === 'playing';
  ui.sound.disabled = !playing;
  ui.fullscreen.disabled = !playing || !document.fullscreenEnabled;
  ui.changeRom.hidden = !rom;
  ui.changeRom.disabled = playing || state === 'loading';
}

function showLoading(text) {
  ui.loadingText.textContent = text;
  ui.loadingDetail.textContent = '';
  ui.meter.style.width = '0';
  setState('loading');
}

function showProgress(loaded, total) {
  ui.meter.style.width = total ? `${Math.min(100, (loaded / total) * 100)}%` : '50%';
  ui.loadingDetail.textContent = total ? `${megabytes(loaded)} of ${megabytes(total)} MB` : `${megabytes(loaded)} MB`;
}

function showError(err, retry) {
  console.error(err);
  stopEmulator();
  ui.errorText.textContent = err?.message || String(err);
  retryAction = retry;
  setState('error');
}

// --- Starting up: ROM, then trainer ------------------------------------------------

async function init() {
  try {
    showLoading('Getting ready');
    if (!manifest) {
      const res = await fetch('game/patches.json');
      if (!res.ok) throw new Error(`Couldn't download game/patches.json (HTTP ${res.status}).`);
      manifest = await res.json();
    }
    if (!rom) {
      const saved = await loadSavedRom();
      if (!saved) {
        showRomCard();
        return;
      }
      try {
        await usePlayerRom(saved);
      } catch (err) {
        if (!(err instanceof RomError)) throw err;
        await forgetRom(); // a ROM saved by an older version of the site
        showRomCard(err.message);
        return;
      }
    }
    await showTrainerOrTitle();
  } catch (err) {
    showError(err, init);
  }
}

function showRomCard(problem = '') {
  ui.romError.textContent = problem;
  ui.romError.hidden = !problem;
  ui.romFile.value = '';
  setState('rom');
}

// save: keep a newly picked ROM in the browser as soon as it's recognised, so
// a failed patch download doesn't mean picking the file again.
async function usePlayerRom(bytes, { save = false } = {}) {
  const source = await identifyRom(bytes, manifest);
  if (save) await saveRom(bytes);
  showLoading('Patching your ROM');
  rom = await patchRom(bytes, source, showProgress);
  try {
    ui.redSprite.src = redSpriteUrl(rom, manifest.redSprite);
    ui.redSprite.hidden = false;
  } catch (err) {
    console.warn("Couldn't draw RED's sprite", err);
  }
}

async function onRomPicked(file) {
  if (!file) return;
  try {
    showLoading('Checking your ROM');
    const bytes = new Uint8Array(await file.arrayBuffer());
    await usePlayerRom(bytes, { save: true });
    await showTrainerOrTitle();
  } catch (err) {
    rom = null;
    if (err instanceof RomError) showRomCard(err.message);
    else showError(err, init);
  }
}

async function showTrainerOrTitle() {
  if (practiceSeed) {
    renderTitle();
    setState('title');
    return;
  }
  if (!savedCode()) {
    showJoin();
    return;
  }
  showLoading('Finding your trainer');
  try {
    await refreshMe();
  } catch (err) {
    if (err.status !== 401) throw err;
    saveCode(null);
    showJoin('This browser had a recovery code the server doesn\'t know. Pick a name to start again, or enter your code.');
    return;
  }
  renderTitle();
  setState('title');
}

function showJoin(problem = '') {
  ui.joinError.textContent = problem;
  ui.joinError.hidden = !problem;
  renderTrainer();
  setState('join');
}

// Once the trainer is known (saved code), go on to the title card.
async function continueToTitle() {
  try {
    await showTrainerOrTitle();
    refreshHallOfFame();
  } catch (err) {
    showError(err, continueToTitle);
  }
}

// Submits a join or restore form once at a time (no double trainers).
async function submitOnce(event, action) {
  event.preventDefault();
  if (joining) return;
  joining = true;
  for (const button of document.querySelectorAll('.card-join button')) button.disabled = true;
  try {
    await action();
  } finally {
    joining = false;
    for (const button of document.querySelectorAll('.card-join button')) button.disabled = false;
  }
}

const onJoin = (event) => submitOnce(event, async () => {
  let code;
  try {
    ({ code } = await createPlayer(ui.joinName.value));
  } catch (err) {
    showJoin(err.message);
    return;
  }
  saveCode(code);
  showCodeBox('Your trainer is ready. This is your recovery code: keep it somewhere safe. It\'s the only way to use this trainer in another browser or device.');
  await continueToTitle();
});

const onRestore = (event) => submitOnce(event, async () => {
  const code = normalizeCode(ui.restoreCode.value);
  if (!code) {
    showJoin('A recovery code is 25 letters and digits, like XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.');
    return;
  }
  try {
    await getMe(code);
  } catch (err) {
    showJoin(err.status === 401 ? "That recovery code doesn't match any trainer." : err.message);
    return;
  }
  saveCode(code);
  ui.codeBox.hidden = true;
  ui.showCode.textContent = 'Recovery code';
  await continueToTitle();
});

// Gets the player's stats and today's battle. If this tab was reloaded during
// a battle, that battle is settled first (see BATTLE_KEY).
async function refreshMe() {
  const left = !run && battleNote();
  if (left) {
    try {
      await sendResult(left.day, left.won ?? false, left.run);
    } catch (err) {
      if (err.status === 0) throw err; // try again next time
    }
    session.remove(BATTLE_KEY);
    refreshHallOfFame();
  }
  me = await getMe();
  renderTrainer();
}

// --- Title card ------------------------------------------------------------------

function renderTitle(note = '') {
  const status = practiceSeed ? 'open' : me.today.status;
  ui.stats.hidden = Boolean(practiceSeed);
  if (me) {
    ui.wins.textContent = me.player.wins;
    ui.losses.textContent = me.player.losses;
    ui.winStreak.textContent = me.player.winStreak;
    ui.dayStreak.textContent = me.player.dayStreak;
  }
  const done = status === 'won' || status === 'lost';
  const elsewhere = status === 'running'; // in another tab or on another device
  ui.play.hidden = done || elsewhere;
  ui.played.hidden = !done;
  if (done) ui.playedResult.textContent = status === 'won' ? 'You beat RED today!' : 'RED won today.';
  const text = practiceSeed ? "Practice run: results aren't saved."
    : elsewhere ? "Today's battle is under way in another tab or on another device." : note;
  ui.titleNote.textContent = text;
  ui.titleNote.hidden = !text;
  updateCountdown();
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

function updateCountdown() {
  if (practiceSeed || !me) return;
  const left = Date.parse(me.today.nextDayAt) - serverNow();
  // At midnight UTC a new battle unlocks: ask the server and redraw the card.
  if (left <= 0) {
    if (refreshingDay) return;
    refreshingDay = true;
    refreshMe().then(() => {
      if (app.dataset.state === 'title') renderTitle();
      refreshHallOfFame();
    }).catch(() => {}).finally(() => { refreshingDay = false; });
    return;
  }
  if (!ui.played.hidden) ui.playedNext.textContent = `Next ranked battle in ${formatTime(left)}`;
}
setInterval(() => {
  if (app.dataset.state === 'title') updateCountdown();
}, 1000);

// --- Trainer card ---------------------------------------------------------------

function renderTrainer() {
  ui.trainer.hidden = !me || Boolean(practiceSeed);
  if (!me) return;
  ui.trainerName.textContent = me.player.name;
  ui.trainerId.textContent = `#${me.player.id}`;
}

function showCodeBox(note) {
  ui.codeNote.textContent = note;
  ui.codeText.textContent = savedCode();
  ui.codeBox.hidden = false;
  ui.showCode.textContent = 'Hide recovery code';
}

ui.showCode.addEventListener('click', () => {
  if (!ui.codeBox.hidden) {
    ui.codeBox.hidden = true;
    ui.showCode.textContent = 'Recovery code';
    return;
  }
  showCodeBox("Your recovery code: it's the only way to use this trainer in another browser or device. Don't share it.");
});

ui.copyCode.addEventListener('click', () => {
  navigator.clipboard?.writeText(savedCode()).then(() => {
    ui.copyCode.textContent = 'Copied';
    setTimeout(() => { ui.copyCode.textContent = 'Copy'; }, 1500);
  }).catch(() => {});
});

ui.changeRom.addEventListener('click', async () => {
  stopEmulator();
  rom = null;
  await forgetRom();
  showRomCard();
});

// --- Hall of fame --------------------------------------------------------------

function fillList(list, rows, describe, empty) {
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'fame-empty';
    li.textContent = empty;
    list.append(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement('li');
    if (row.id === me?.player.id) li.classList.add('is-me');
    const name = document.createElement('span');
    name.className = 'fame-name';
    name.textContent = row.name;
    const id = document.createElement('span');
    id.className = 'fame-id';
    id.textContent = `#${row.id}`;
    const value = document.createElement('span');
    value.className = 'fame-value';
    value.textContent = describe(row);
    li.append(name, id, value);
    list.append(li);
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function refreshHallOfFame() {
  if (practiceSeed) return;
  let data;
  try {
    data = await getHallOfFame();
  } catch {
    ui.fameSummary.textContent = "The hall of fame couldn't be loaded.";
    return;
  }
  const { played, won } = data.today;
  ui.fameSummary.textContent = played
    ? `Today ${won} of ${plural(played, 'trainer')} beat RED.`
    : 'No one has battled RED yet today.';
  fillList(ui.fameToday, data.today.winners, (r) => clock(r.at), 'No champions yet today.');
  fillList(ui.fameWins, data.wins, (r) => plural(r.wins, 'win'), 'No wins yet.');
  fillList(ui.fameStreaks, data.streaks, (r) => `${r.streak} in a row`, 'No win streaks right now.');
}
setInterval(() => {
  if (app.dataset.state !== 'title' || document.hidden) return;
  refreshHallOfFame();
  // A battle running elsewhere: show its result once it's in.
  if (me?.today.status === 'running') {
    refreshMe().then(() => { if (app.dataset.state === 'title') renderTitle(); }).catch(() => {});
  }
}, 60000);

// --- Running the game --------------------------------------------------------------

function checkBrowser() {
  if (typeof WebAssembly !== 'object' || typeof DecompressionStream !== 'function') {
    throw new Error("This browser can't run the game. Use a recent version of Chrome, Edge, Firefox or Safari.");
  }
}

function stopEmulator() {
  clearInterval(pollTimer);
  pollTimer = null;
  readGame = null;
  if (emu) {
    try {
      emu.exit();
    } catch (err) {
      console.warn('Emulator exit failed', err);
    }
    emu = null;
  }
  for (const ctx of audioContexts.splice(0)) ctx.close().catch(() => {});
}

// Play: the day's battle (or a practice run). rematch: another go with the
// day's team once the day's battle is done; it isn't sent to the server.
async function startRun({ rematch = false } = {}) {
  if (starting) return;
  starting = true;
  try {
    checkBrowser();
    stopEmulator();
    showLoading('Downloading the game');
    const core = await loadCore(showProgress);

    let config;
    rematching = false;
    if (practiceSeed) {
      config = { seed: practiceSeed };
    } else if (rematch) {
      await refreshMe(); // the day may have changed: then it's a new day's battle
      if (me.today.status !== 'won' && me.today.status !== 'lost') {
        renderTitle();
        setState('title');
        return;
      }
      rematching = true;
      config = { seed: me.today.seed, rematch: true };
    } else {
      await refreshMe(); // another tab or device may have played meanwhile
      if (me.today.status !== 'open') {
        renderTitle();
        setState('title');
        return;
      }
      run = { day: me.today.day, id: newRunId(), battleSeen: false, start: null, result: null };
      config = { seed: me.today.seed, wins: me.player.wins, battles: me.player.wins + me.player.losses, daily: true };
    }

    ui.loadingText.textContent = 'Starting the emulator';
    ui.loadingDetail.textContent = '';
    ui.meter.style.width = '100%';

    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    screen.prepend(canvas);
    emu = await Nostalgist.launch({
      core: 'mgba',
      element: canvas,
      size: { width: 720, height: 480 }, // render at 3x; CSS scales it to fit
      rom: { fileName: 'dailyred.gba', fileContent: new Blob([injectConfig(rom, config)]) },
      resolveCoreJs: () => core.coreJs,
      resolveCoreWasm: () => core.coreWasm,
      retroarchConfig: {
        audio_mute_enable: muted,
        // The site never makes save states itself; uncompressed ones let the
        // debugging tools in tests/ read the game's RAM.
        savestate_file_compression: false,
        savestate_thumbnail_enable: false,
      },
    });

    readGame = createGameLink(emu, config.seed);
    pollTimer = setInterval(watchGame, 500);
    setState('playing');
  } catch (err) {
    run = null;
    showError(err, () => startRun({ rematch }));
  } finally {
    starting = false;
  }
}

// Follows the daily battle: once it starts the day counts as played (the
// server is told), the result is sent as soon as it's known, and when the game
// has finished its closing messages we go back to the title card.
function watchGame() {
  let status;
  try {
    status = readGame?.();
  } catch {
    return;
  }
  if (!status) return;
  if (rematching) {
    if (status.phase === PHASE.FINISHED) endRematch();
    return;
  }
  if (!run) return;
  if (status.phase >= PHASE.BATTLE) {
    run.battleSeen = true;
    reportStart();
  } else if (run.battleSeen && status.result === RESULT.NONE) {
    // The game restarted mid-battle: that's a loss, like leaving the page.
    reportResult(false);
    endDailyGame(0);
    return;
  }
  if (status.result !== RESULT.NONE) reportResult(status.result === RESULT.WON);
  if (status.phase === PHASE.FINISHED) endDailyGame(1000);
}

// Tells the server RED's battle began. Network failures are retried with the
// same run ID, which the server accepts again. Resolves true once recorded.
function reportStart() {
  if (run.start) return;
  const thisRun = run;
  thisRun.start = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const data = await startBattle(thisRun.day, thisRun.id);
        me.today = data.today;
        session.set(BATTLE_KEY, JSON.stringify({ day: thisRun.day, run: thisRun.id, won: null }));
        return true;
      } catch (err) {
        if (err.status !== 0 || attempt === 8) {
          // Already played today (another tab or device), the day is over, or no connection.
          endDailyGame(0, err.message);
          return false;
        }
        await sleep(1000 * attempt);
      }
    }
  })();
}

// Sends the result once the start is recorded. If it can't be sent, the tab
// keeps it (BATTLE_KEY) and sends it on the next refresh or reload.
function reportResult(won) {
  if (run.result) return;
  const thisRun = run;
  thisRun.result = (async () => {
    if (!(await thisRun.start)) return;
    session.set(BATTLE_KEY, JSON.stringify({ day: thisRun.day, run: thisRun.id, won }));
    for (let attempt = 1; ; attempt++) {
      try {
        me = await sendResult(thisRun.day, won, thisRun.id);
        session.remove(BATTLE_KEY);
        return;
      } catch (err) {
        if (err.status !== 0) {
          console.warn("The result wasn't accepted", err);
          session.remove(BATTLE_KEY);
          return;
        }
        if (attempt === 5) return;
        await sleep(2000 * attempt);
      }
    }
  })();
}

// A rematch is over: back to the title card, nothing to report.
function endRematch() {
  clearInterval(pollTimer);
  pollTimer = null;
  setTimeout(() => {
    stopEmulator();
    rematching = false;
    renderTitle();
    setState('title');
  }, 1000);
}

function endDailyGame(delayMs, note = '') {
  clearInterval(pollTimer);
  pollTimer = null;
  const thisRun = run;
  setTimeout(async () => {
    stopEmulator();
    showLoading('Saving your result');
    ui.meter.style.width = '100%';
    await thisRun?.result;
    run = null;
    try {
      await refreshMe();
    } catch (err) {
      note ||= err.message;
    }
    renderTitle(note);
    setState('title');
    refreshHallOfFame();
  }, delayMs);
}

// --- ROM card and trainer card inputs ---------------------------------------------

ui.romFile.addEventListener('change', () => onRomPicked(ui.romFile.files[0]));

// Dropping a file anywhere on the screen works too.
screen.addEventListener('dragover', (event) => {
  if (app.dataset.state !== 'rom') return;
  event.preventDefault();
  screen.classList.add('is-dragging');
});
screen.addEventListener('dragleave', () => screen.classList.remove('is-dragging'));
screen.addEventListener('drop', (event) => {
  screen.classList.remove('is-dragging');
  if (app.dataset.state !== 'rom') return;
  event.preventDefault();
  onRomPicked(event.dataTransfer.files[0]);
});

ui.joinForm.addEventListener('submit', onJoin);
ui.restoreForm.addEventListener('submit', onRestore);
ui.toggleRestore.addEventListener('click', () => {
  const restoring = ui.restoreForm.hidden;
  ui.restoreForm.hidden = !restoring;
  ui.joinForm.hidden = restoring;
  ui.toggleRestore.textContent = restoring ? 'New trainer' : 'I have a recovery code';
  (restoring ? ui.restoreCode : ui.joinName).focus();
});

// --- Toolbar ---------------------------------------------------------------------

// Buttons keep focus after a click, and Enter is the game's Start button, so
// hand focus back to the page to avoid triggering the button again.
function onClick(button, handler) {
  button.addEventListener('click', () => {
    button.blur();
    handler();
  });
}

onClick(ui.play, () => startRun());
onClick(ui.playAgain, () => startRun({ rematch: true }));
onClick(ui.retry, () => (retryAction ?? init)());

onClick(ui.sound, () => {
  if (!emu) return;
  emu.sendCommand('MUTE');
  muted = !muted;
  session.set('dailyred-muted', muted ? '1' : '0');
  showMuted();
});

function showMuted() {
  ui.sound.textContent = muted ? 'Unmute' : 'Mute';
  ui.sound.setAttribute('aria-pressed', String(muted));
}

onClick(ui.fullscreen, () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('console').requestFullscreen().catch(() => {});
});

document.addEventListener('fullscreenchange', () => {
  ui.fullscreen.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
});

// Don't let arrow keys and space scroll the page while playing.
window.addEventListener('keydown', (event) => {
  if (app.dataset.state === 'playing' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) {
    event.preventDefault();
  }
});

// Pause when the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (!emu) return;
  if (document.hidden) emu.pause();
  else emu.resume();
});

// Browsers start audio suspended unless it begins during a click; the
// emulator starts after the download, so resume it on the next interaction.
function resumeAudio() {
  for (const ctx of audioContexts) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
}
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('keydown', resumeAudio);

// --- Touch controls ------------------------------------------------------------

for (const button of document.querySelectorAll('[data-button]')) {
  const release = () => {
    if (!button.classList.contains('is-down')) return;
    button.classList.remove('is-down');
    emu?.pressUp(button.dataset.button);
  };
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add('is-down');
    emu?.pressDown(button.dataset.button);
  });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

// The d-pad follows the finger, so sliding from one direction to another works.
const dpad = document.querySelector('.dpad');
let heldDirection = null;

function setDirection(next) {
  if (next === heldDirection) return;
  if (heldDirection) emu?.pressUp(heldDirection);
  if (next) emu?.pressDown(next);
  heldDirection = next;
  dpad.dataset.dir = next ?? '';
}

function directionAt(event) {
  const box = dpad.getBoundingClientRect();
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  if (Math.hypot(dx, dy) < box.width * 0.12) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

dpad.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  dpad.setPointerCapture(event.pointerId);
  setDirection(directionAt(event));
});
dpad.addEventListener('pointermove', (event) => {
  if (dpad.hasPointerCapture(event.pointerId)) setDirection(directionAt(event));
});
dpad.addEventListener('pointerup', () => setDirection(null));
dpad.addEventListener('pointercancel', () => setDirection(null));

// For debugging from the console and for the automated tests.
window.dailyRed = {
  get emulator() { return emu; },
  get player() { return me && { ...me.player }; },
  get today() { return me && { ...me.today }; },
};

showMuted();
ui.fullscreen.hidden = !document.fullscreenEnabled; // e.g. iPhone Safari
ui.fame.hidden = Boolean(practiceSeed);
refreshHallOfFame(); // shown to everyone, even before they load a ROM
init();
