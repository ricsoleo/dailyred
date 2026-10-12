// Applies a BPS patch (the usual ROM-hack patch format, by byuu) to the
// player's own FireRed ROM. The site only ever ships the patch: the game data
// comes from the ROM the player loads (see rom-store.js).
//
// Format: "BPS1", then varint source size, target size and metadata length,
// the metadata, a list of copy/insert actions, and three little-endian CRC32s
// (source, target, patch). scripts/make-bps.mjs writes these files.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class PatchError extends Error {}

const SOURCE_READ = 0, TARGET_READ = 1, SOURCE_COPY = 2, TARGET_COPY = 3;

// Returns the patched ROM. Throws PatchError if the patch is damaged, if
// `source` isn't the ROM it was made for, or if the result doesn't match.
export function applyBps(source, patch) {
  if (patch.length < 16 || String.fromCharCode(...patch.subarray(0, 4)) !== 'BPS1') {
    throw new PatchError('Not a BPS patch.');
  }
  const footer = new DataView(patch.buffer, patch.byteOffset + patch.length - 12, 12);
  const sourceCrc = footer.getUint32(0, true);
  const targetCrc = footer.getUint32(4, true);
  const patchCrc = footer.getUint32(8, true);
  // The patch's own CRC covers everything before it, including the other two.
  if (crc32(patch, 0, patch.length - 4) !== patchCrc) throw new PatchError('The patch file is damaged.');
  if (crc32(source) !== sourceCrc) throw new PatchError("This ROM isn't the one the patch was made for.");

  let p = 4;
  const end = patch.length - 12;
  // Varints can exceed 2^32, so add with multiplication rather than shifts.
  const varint = () => {
    let value = 0, shift = 1;
    for (;;) {
      if (p >= end) throw new PatchError('The patch file is damaged.');
      const byte = patch[p++];
      value += (byte & 0x7F) * shift;
      if (byte & 0x80) return value;
      shift *= 128;
      value += shift;
    }
  };
  const signed = () => {
    const n = varint();
    return (n % 2 ? -1 : 1) * Math.floor(n / 2);
  };

  const sourceSize = varint();
  const targetSize = varint();
  const metadataLength = varint(); // (not `p += varint()`: that reads p before the call moves it)
  p += metadataLength; // metadata, unused
  if (sourceSize !== source.length) throw new PatchError("This ROM isn't the one the patch was made for.");

  const target = new Uint8Array(targetSize);
  let out = 0, sourceRel = 0, targetRel = 0;
  while (p < end) {
    const data = varint();
    const action = data % 4;
    const length = Math.floor(data / 4) + 1;
    if (out + length > targetSize) throw new PatchError('The patch file is damaged.');
    switch (action) {
      case SOURCE_READ:
        target.set(source.subarray(out, out + length), out);
        break;
      case TARGET_READ:
        target.set(patch.subarray(p, p + length), out);
        p += length;
        break;
      case SOURCE_COPY:
        sourceRel += signed();
        target.set(source.subarray(sourceRel, sourceRel + length), out);
        sourceRel += length;
        break;
      case TARGET_COPY:
        targetRel += signed();
        // May overlap the bytes being written (that's how runs are encoded),
        // so copy one byte at a time.
        for (let i = 0; i < length; i++) target[out + i] = target[targetRel + i];
        targetRel += length;
        break;
    }
    out += length;
  }
  if (out !== targetSize || crc32(target) !== targetCrc) throw new PatchError("The patched ROM doesn't match. Try loading your ROM again.");
  return target;
}
