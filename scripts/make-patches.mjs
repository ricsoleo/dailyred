// Writes the website's patches and their manifest (called by build-patches.sh).
//   node scripts/make-patches.mjs <firered v1.0> <firered v1.1> <dailyred.gba> <dailyred.elf> <out dir>
//
// Output in <out dir> (web/game/):
//   firered-v1.0.bps.gz, firered-v1.1.bps.gz   gzipped BPS patches
//   patches.json   which ROMs the site accepts (by SHA-1), the patch for each,
//                  and where RED's sprite is in the patched ROM (the site draws
//                  the title card's sprite from it, so it ships no game art)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createBps } from './make-bps.mjs';
import { applyBps } from '../web/bps.js';

const RELEASES = [
  { name: 'Pokémon FireRed (USA) v1.0', file: 'firered-v1.0.bps.gz', sha1: '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc' },
  { name: 'Pokémon FireRed (USA) v1.1', file: 'firered-v1.1.bps.gz', sha1: 'dd5945db9b930750cb39d00c84da8571feebf417' },
];

const [v10Path, v11Path, romPath, elfPath, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node scripts/make-patches.mjs <firered v1.0> <firered v1.1> <dailyred.gba> <dailyred.elf> <out dir>');
  process.exit(1);
}

const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex');
const read = (path) => new Uint8Array(readFileSync(path));

const target = read(romPath);
mkdirSync(outDir, { recursive: true });
// Older builds put the whole ROM here; it must never be deployed.
rmSync(join(outDir, 'dailyred.gba.gz'), { force: true });
rmSync(join(outDir, 'red.png'), { force: true });

const sources = [];
for (const [release, path] of [[RELEASES[0], v10Path], [RELEASES[1], v11Path]]) {
  const source = read(path);
  if (sha1(source) !== release.sha1) throw new Error(`${path} isn't ${release.name} (SHA-1 ${sha1(source)})`);
  const patch = createBps(source, target);
  const check = applyBps(source, patch);
  if (sha1(check) !== sha1(target)) throw new Error(`patch for ${release.name} doesn't reproduce the ROM`);
  const gz = gzipSync(patch, { level: 9 });
  writeFileSync(join(outDir, release.file), gz);
  sources.push({ name: release.name, sha1: release.sha1, patch: release.file, bytes: gz.length });
  console.log(`${release.file}: ${gz.length} bytes`);
}

// ROM offsets of RED's battle sprite (LZ77-compressed 4bpp tiles and palette).
const symbols = Object.fromEntries(
  execFileSync('arm-none-eabi-nm', [elfPath], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').map((line) => line.split(' ')).filter((p) => p.length === 3).map(([addr, , name]) => [name, parseInt(addr, 16)]),
);
const romOffset = (name) => {
  if (!symbols[name]) throw new Error(`symbol ${name} not found in ${elfPath}`);
  return symbols[name] - 0x08000000;
};

const manifest = {
  rom: { sha1: sha1(target), bytes: target.length },
  sources,
  redSprite: { pic: romOffset('gTrainerFrontPic_Red'), palette: romOffset('gTrainerPalette_Red') },
};
writeFileSync(join(outDir, 'patches.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`patches.json: Daily Red ${manifest.rom.sha1.slice(0, 12)}`);
