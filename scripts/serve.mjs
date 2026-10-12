// Minimal static file server for the game tests (no dependencies).
//   node scripts/serve.mjs [port]      -> serves ./web on http://localhost:8080
//
// It also serves your locally built ROM at /__local__/dailyred.gba, which
// tests/lib.mjs boots directly. The website itself needs the API: to play
// locally, use the dev script in server/ instead (see README).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../web', import.meta.url)));
const localRom = fileURLToPath(new URL('../pokefirered/pokefirered_modern.gba', import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gba': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname === '/__local__/dailyred.gba' ? localRom : normalize(join(root, decodeURIComponent(url.pathname)));
    if (path !== localRom && !path.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'EACCES' ? 403 : 404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});
server.listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${server.address().port}`);
});
