// The Daily Red server (server/src/index.js): your trainer, today's battle and
// the hall of fame. Your recovery code is the key to your trainer; it's kept
// in this browser's localStorage.

const CODE_KEY = 'dailyred-code';
let memoryCode = null; // used when localStorage is blocked

export function savedCode() {
  try {
    return localStorage.getItem(CODE_KEY) ?? memoryCode;
  } catch {
    return memoryCode;
  }
}

export function saveCode(code) {
  memoryCode = code;
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch { /* kept until the page closes */ }
}

// A recovery code as typed or pasted: any case, any separators, and the usual
// look-alikes (O for 0, I and L for 1). Returns XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
// or null. The server accepts the same forms.
export function normalizeCode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{25}$/.test(clean) ? clean.match(/.{5}/g).join('-') : null;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The server's clock minus ours, from the latest response that carried it.
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;

async function call(method, path, body, code = savedCode()) {
  const headers = {};
  if (code) headers.Authorization = `Bearer ${code}`;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`api/${path}`, { method, headers, body: body && JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Couldn't reach the Daily Red server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `The server had a problem (HTTP ${res.status}).`);
  const now = data.today?.now ?? data.now;
  if (now) clockOffset = Date.parse(now) - Date.now();
  return data;
}

export const createPlayer = (name) => call('POST', 'players', { name });
export const getMe = (code) => call('GET', 'me', undefined, code);
// `run` is a random ID for one battle on one page (see server/src/index.js).
export const startBattle = (day, run) => call('POST', 'battles/start', { day, run });
export const sendResult = (day, won, run) => call('POST', 'battles/result', { day, won, run });
export const getHallOfFame = () => call('GET', 'halloffame');
