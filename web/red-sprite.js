// Draws RED's battle sprite for the title card straight from the patched ROM,
// so the site itself ships no game art. game/patches.json says where the
// sprite is: 64x64 4bpp tiles and a 16-colour palette, both LZ77-compressed
// (the GBA BIOS format, type 0x10).

function lz77(rom, offset) {
  if (rom[offset] !== 0x10) throw new Error('not LZ77 data');
  const size = rom[offset + 1] | (rom[offset + 2] << 8) | (rom[offset + 3] << 16);
  const out = new Uint8Array(size);
  let o = 0, p = offset + 4;
  while (o < size) {
    const flags = rom[p++];
    for (let bit = 7; bit >= 0 && o < size; bit--) {
      if (flags & (1 << bit)) {
        const b0 = rom[p++], b1 = rom[p++];
        const length = (b0 >> 4) + 3;
        const distance = (((b0 & 0xF) << 8) | b1) + 1;
        for (let k = 0; k < length && o < size; k++, o++) out[o] = out[o - distance];
      } else {
        out[o++] = rom[p++];
      }
    }
  }
  return out;
}

// Returns a PNG data URL of the 64x64 sprite (colour 0 is transparent).
export function redSpriteUrl(rom, { pic, palette }) {
  const tiles = lz77(rom, pic);
  const pal = lz77(rom, palette);
  const colors = Array.from({ length: 16 }, (_, i) => {
    const c = pal[i * 2] | (pal[i * 2 + 1] << 8); // BGR555
    return [c & 31, (c >> 5) & 31, (c >> 10) & 31].map((v) => Math.round((v * 255) / 31));
  });

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(64, 64);
  for (let tile = 0; tile < 64; tile++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const byte = tiles[tile * 32 + y * 4 + (x >> 1)];
        const index = x & 1 ? byte >> 4 : byte & 0xF;
        if (!index) continue;
        const px = ((tile >> 3) * 8 + y) * 64 + (tile & 7) * 8 + x;
        image.data.set([...colors[index], 255], px * 4);
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
