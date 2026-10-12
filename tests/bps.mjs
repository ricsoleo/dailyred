// BPS round trips: scripts/make-bps.mjs writes patches that web/bps.js applies,
// across copies, runs, inserts, growth and shrinking, and damaged or wrong
// inputs are rejected. Runs in a second; no ROM needed.
import { createBps } from '../scripts/make-bps.mjs';
import { applyBps, crc32, PatchError } from '../web/bps.js';

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

// Deterministic pseudo-random bytes.
function random(length, seed) {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xFF;
  }
  return out;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function roundTrip(name, source, target) {
  let result;
  try {
    result = applyBps(source, createBps(source, target));
  } catch (err) {
    check(false, `${name}: ${err.message}`);
    return;
  }
  check(same(result, target), name);
}

check(crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'CRC32 check value');

const base = random(200000, 1);
roundTrip('identical', base, base.slice());
roundTrip('tiny', new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4]));
roundTrip('empty target', base, new Uint8Array(0));
roundTrip('runs', new Uint8Array(1000).fill(7), new Uint8Array(5000).fill(9));

const edited = base.slice();
for (let i = 0; i < edited.length; i += 997) edited[i] ^= 0x5A;
roundTrip('scattered edits', base, edited);

// Blocks moved around, some new data, a repeated block and a long run.
const moved = new Uint8Array(260000);
moved.set(base.subarray(150000, 200000), 0);
moved.set(random(10000, 2), 50000);
moved.set(base.subarray(0, 100000), 60000);
moved.set(base.subarray(0, 50000), 160000);
moved.fill(0xFF, 210000);
roundTrip('moved blocks, inserts, repeats and padding', base, moved);
roundTrip('shrinking', base, base.subarray(5000, 9000));

const patch = createBps(base, edited);
const damaged = patch.slice();
damaged[20] ^= 1;
const rejects = (fn, what) => {
  try { fn(); } catch (err) { return err instanceof PatchError; }
  return false;
};
check(rejects(() => applyBps(base, damaged)), 'a damaged patch is rejected');
check(rejects(() => applyBps(random(200000, 9), patch)), 'the wrong source ROM is rejected');
check(rejects(() => applyBps(base, new Uint8Array(40))), 'something that is not a patch is rejected');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
