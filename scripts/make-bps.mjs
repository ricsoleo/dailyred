// Writes a BPS patch that turns one ROM into another (no dependencies).
//   node scripts/make-bps.mjs <source.gba> <target.gba> <out.bps>
//
// Greedy encoder: at each byte it takes the longest of
//   - SourceRead  (the same bytes at the same offset in the source),
//   - SourceCopy  (the bytes anywhere in the source, found via a hash chain),
//   - TargetCopy  (bytes already written, which also covers runs),
// and otherwise emits literal bytes (TargetRead). The game data the patch
// copies from is the player's own ROM; only the changed bytes are in the patch.
// The result is checked by applying it with web/bps.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { applyBps, crc32 } from '../web/bps.js';

const HASH_BITS = 22;
const SOURCE_DEPTH = 48;  // hash-chain candidates tried per position
const TARGET_DEPTH = 16;
const MIN_COPY = 8;       // shorter matches cost about as much as the bytes
const MIN_READ = 4;       // SourceRead has no offset to encode

const hash4 = (buf, i) => (Math.imul(buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24), 0x9E3779B1) >>> (32 - HASH_BITS));

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 20); this.length = 0; }
  byte(b) {
    if (this.length === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.length++] = b;
  }
  bytes(arr) { for (const b of arr) this.byte(b); }
  varint(n) {
    for (;;) {
      const x = n % 128;
      n = Math.floor(n / 128);
      if (n === 0) { this.byte(0x80 | x); return; }
      this.byte(x);
      n--;
    }
  }
  signed(n) { this.varint(Math.abs(n) * 2 + (n < 0 ? 1 : 0)); }
  u32(n) { for (let i = 0; i < 4; i++) this.byte((n >>> (8 * i)) & 0xFF); }
  result() { return this.buf.slice(0, this.length); }
}

function matchLength(a, ai, b, bi, max) {
  let n = 0;
  while (n < max && a[ai + n] === b[bi + n]) n++;
  return n;
}

export function createBps(source, target) {
  // Hash chains: head[h] is the latest position with hash h, prev[i] the one before.
  const sourceHead = new Int32Array(1 << HASH_BITS).fill(-1);
  const sourcePrev = new Int32Array(source.length);
  for (let i = 0; i + 4 <= source.length; i++) {
    const h = hash4(source, i);
    sourcePrev[i] = sourceHead[h];
    sourceHead[h] = i;
  }
  const targetHead = new Int32Array(1 << HASH_BITS).fill(-1);
  const targetPrev = new Int32Array(target.length);
  let indexed = 0; // target positions below this are in the target chain
  const indexTarget = (upTo) => {
    for (; indexed < upTo && indexed + 4 <= target.length; indexed++) {
      const h = hash4(target, indexed);
      targetPrev[indexed] = targetHead[h];
      targetHead[h] = indexed;
    }
  };

  const out = new Writer();
  out.bytes([0x42, 0x50, 0x53, 0x31]); // "BPS1"
  out.varint(source.length);
  out.varint(target.length);
  out.varint(0); // no metadata

  let sourceRel = 0, targetRel = 0;
  let literalStart = -1;
  const flushLiteral = (end) => {
    if (literalStart < 0) return;
    out.varint(((end - literalStart - 1) * 4) + 1);
    out.bytes(target.subarray(literalStart, end));
    literalStart = -1;
  };

  let i = 0;
  while (i < target.length) {
    const max = target.length - i;
    let bestLen = 0, bestAction = -1, bestFrom = 0;

    if (i < source.length) {
      const len = matchLength(source, i, target, i, Math.min(max, source.length - i));
      if (len >= MIN_READ) { bestLen = len; bestAction = 0; }
    }
    if (i + 4 <= target.length) {
      const h = hash4(target, i);
      for (let c = sourceHead[h], d = 0; c >= 0 && d < SOURCE_DEPTH; c = sourcePrev[c], d++) {
        const len = matchLength(source, c, target, i, Math.min(max, source.length - c));
        if (len > bestLen + 2 && len >= MIN_COPY) { bestLen = len; bestAction = 2; bestFrom = c; }
      }
      indexTarget(i);
      for (let c = targetHead[h], d = 0; c >= 0 && d < TARGET_DEPTH; c = targetPrev[c], d++) {
        const len = matchLength(target, c, target, i, max);
        if (len > bestLen + 2 && len >= MIN_COPY) { bestLen = len; bestAction = 3; bestFrom = c; }
      }
    }

    if (bestAction < 0) {
      if (literalStart < 0) literalStart = i;
      i++;
      continue;
    }
    flushLiteral(i);
    out.varint(((bestLen - 1) * 4) + bestAction);
    if (bestAction === 2) {
      out.signed(bestFrom - sourceRel);
      sourceRel = bestFrom + bestLen;
    } else if (bestAction === 3) {
      out.signed(bestFrom - targetRel);
      targetRel = bestFrom + bestLen;
    }
    i += bestLen;
  }
  flushLiteral(target.length);

  out.u32(crc32(source));
  out.u32(crc32(target));
  const body = out.result();
  out.u32(crc32(body));
  return out.result();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sourcePath, targetPath, outPath] = process.argv.slice(2);
  if (!outPath) {
    console.error('Usage: node scripts/make-bps.mjs <source.gba> <target.gba> <out.bps>');
    process.exit(1);
  }
  const source = new Uint8Array(readFileSync(sourcePath));
  const target = new Uint8Array(readFileSync(targetPath));
  const patch = createBps(source, target);
  const check = applyBps(source, patch);
  if (check.length !== target.length || !check.every((b, k) => b === target[k])) throw new Error('patch check failed');
  writeFileSync(outPath, patch);
  console.log(`${outPath}: ${patch.length} bytes (checked)`);
}
