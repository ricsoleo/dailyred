// The player's own Pokémon FireRed ROM. The site never ships the game: the
// player picks their ROM once, it's kept in this browser (IndexedDB), and the
// matching patch from game/ (see game/patches.json and scripts/build-patches.sh)
// turns it into Daily Red in memory.
import { applyBps } from './bps.js';
import { fetchAll, gunzip } from './game-files.js';

const DB_NAME = 'dailyred';
const STORE = 'files';
const KEY = 'firered-rom';

export class RomError extends Error {}

let memoryCopy = null; // used when IndexedDB is blocked

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadSavedRom() {
  try {
    const saved = await withStore('readonly', (store) => store.get(KEY));
    return saved ? new Uint8Array(saved) : memoryCopy;
  } catch {
    return memoryCopy;
  }
}

export async function saveRom(bytes) {
  memoryCopy = bytes;
  try {
    await withStore('readwrite', (store) => store.put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), KEY));
  } catch {
    // Storage blocked (e.g. some private modes): the ROM lasts until the page closes.
  }
}

export async function forgetRom() {
  memoryCopy = null;
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch { /* nothing saved */ }
}

async function sha1(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));

// Which supported ROM this is: an entry of manifest.sources, or the Daily Red
// ROM itself (a developer's own build). Throws RomError with a helpful message.
export async function identifyRom(bytes, manifest) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
    throw new RomError("That's a zip file. Unzip it first, then choose the .gba file inside.");
  }
  const hash = await sha1(bytes);
  if (hash === manifest.rom.sha1) return { name: 'Daily Red', patch: null };
  const source = manifest.sources.find((s) => s.sha1 === hash);
  if (source) return source;

  const supported = 'Daily Red needs Pokémon FireRed (USA), version 1.0 or 1.1, unmodified.';
  const code = bytes.length >= 0xB0 ? ascii(bytes, 0xAC, 4) : '';
  if (code === 'BPRE') throw new RomError(`This FireRed ROM has been changed (patched or saved over). ${supported}`);
  if (code.startsWith('BPR')) throw new RomError(`That's FireRed from another region. ${supported}`);
  if (code.startsWith('BPG')) throw new RomError(`That's LeafGreen. ${supported}`);
  throw new RomError(`That isn't a Pokémon FireRed ROM. ${supported}`);
}

// The Daily Red ROM, made from the player's ROM and its patch.
export async function patchRom(bytes, source, onProgress) {
  if (!source.patch) return bytes;
  const [gz] = await fetchAll([`game/${source.patch}`], onProgress);
  return applyBps(bytes, await gunzip(gz));
}
