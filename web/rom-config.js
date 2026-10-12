// Writes the run settings into the Daily Red ROM image before it is booted.
//
// The game keeps a small struct in ROM (gDailyRedRomConfig in
// pokefirered/src/dailyred.c): the 16-byte magic "DAILYRED-CONF-V2", then
// little-endian u32 seed, u16 wins, u16 battles and u8 mode (DAILYRED_MODE_* in
// include/constants/dailyred.h). Finding it by its
// magic means no addresses are hard-coded here. A non-zero seed makes the game
// skip the title screen and generate its team from that seed.

const MAGIC = new TextEncoder().encode('DAILYRED-CONF-V2');

export function findConfigOffset(rom) {
  const first = MAGIC[0];
  outer: for (let i = rom.indexOf(first); i !== -1; i = rom.indexOf(first, i + 1)) {
    for (let j = 1; j < MAGIC.length; j++) {
      if (rom[i + j] !== MAGIC[j]) continue outer;
    }
    return i + MAGIC.length;
  }
  return -1;
}

// Returns a patched copy of `rom` (a Uint8Array); the original is untouched.
//   seed     non-zero team seed
//   wins     the player's record before this game (shown in the game's
//   battles  record message)
//   daily    true for the day's battle: one battle, the record, then the game ends
//   rematch  true for another go with the day's team: one battle that doesn't
//            count (no record), then the game ends
// Neither: free play, with a new team after every battle (practice runs).
export function injectConfig(rom, { seed, wins = 0, battles = 0, daily = false, rematch = false }) {
  const offset = findConfigOffset(rom);
  if (offset < 0) throw new Error('This ROM has no Daily Red config. Rebuild it with scripts/build-rom.sh.');
  const patched = rom.slice();
  const view = new DataView(patched.buffer);
  view.setUint32(offset, seed >>> 0, true);
  view.setUint16(offset + 4, Math.min(wins, 0xFFFF), true);
  view.setUint16(offset + 6, Math.min(battles, 0xFFFF), true);
  view.setUint8(offset + 8, rematch ? 2 : daily ? 1 : 0);
  return patched;
}

// Parses a seed typed by a person, e.g. from ?seed=1234. Returns null if invalid.
export function parseSeed(text) {
  if (text == null || !/^\d{1,10}$/.test(String(text).trim())) return null;
  const seed = Number(text);
  return seed >= 1 && seed <= 0xFFFFFFFF ? seed : null;
}
