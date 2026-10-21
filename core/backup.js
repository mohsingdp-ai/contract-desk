// One backup file for desktop and phone: a plain tar archive (opens with 7-Zip, tar, …) holding, in this order,
//   manifest.json  what is inside: format, app version, counts, and the size + SHA-256 of every other entry. First, so a
//                  restore knows what to expect before it writes anything.
//   contracts.db   a consistent copy of the database in rollback (non-WAL) mode, which the phone can open
//   files/<name>   every stored document file
// Tar because both sides write and read it piece by piece (512-byte blocks): a backup of any size never has to fit in
// memory. Plain JS only: it also runs in the phone app.
import { HttpError } from './rules.js';

export const BACKUP_FORMAT = 1;
export const REMIND_AFTER_DAYS = 14;
export const backupFileName = () => `contract-desk-backup-${new Date().toISOString().slice(0, 10)}.tar`;
export const COUNTS_SQL = 'SELECT (SELECT count(*) FROM contracts) AS contracts, (SELECT count(*) FROM nocs) AS nocs, (SELECT count(*) FROM documents) AS documents';

export const backupManifest = ({ appVersion, from, counts, files }) =>
  JSON.stringify({ app: 'Contract Desk', format: BACKUP_FORMAT, appVersion, from, made: new Date().toISOString(), counts, files });

export const damaged = (why) => new HttpError(400, `This backup file is damaged or is not a Contract Desk backup (${why}). Nothing was changed.`);

// ---------- tar (ustar) ----------

const BLOCK = 512;
export const tarPad = (size) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
export const tarEnd = () => new Uint8Array(2 * BLOCK);
const octal = (h, at, len) => parseInt(new TextDecoder().decode(h.subarray(at, at + len)).replace(/\0.*$/s, '').trim() || '0', 8);
const checksum = (h) => h.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);

export function tarHeader(name, size) {
  const h = new Uint8Array(BLOCK);
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 100) throw new Error(`Name too long for the backup: ${name}`);
  const put = (at, s) => h.set(new TextEncoder().encode(s), at);
  h.set(bytes, 0);
  put(100, '0000644\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, `${size.toString(8).padStart(11, '0')}\0`);
  put(136, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`);
  h[156] = 48; // '0': a regular file
  put(257, 'ustar\x0000');
  put(148, `${checksum(h).toString(8).padStart(6, '0')}\0 `);
  return h;
}

// Reads an archive from an async iterable of byte chunks. For each entry, open(name, size) returns a function that is
// given the entry's bytes piece by piece (a piece is only valid during the call), then null at the end.
export async function readTar(chunks, open) {
  const head = new Uint8Array(BLOCK);
  let have = 0;
  let left = 0;
  let skip = 0;
  let padding = 0;
  let sink;
  let ended = false;
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length && !ended; ) {
      if (skip) {
        const n = Math.min(skip, chunk.length - i);
        (skip -= n), (i += n);
      } else if (left) {
        const n = Math.min(left, chunk.length - i);
        await sink(chunk.subarray(i, i + n));
        (left -= n), (i += n);
        if (!left) await sink(null), (skip = padding);
      } else {
        const n = Math.min(BLOCK - have, chunk.length - i);
        head.set(chunk.subarray(i, i + n), have);
        (have += n), (i += n);
        if (have < BLOCK) continue;
        have = 0;
        if (head.every((b) => b === 0)) {
          ended = true; // the rest is the end marker; read on so the whole stream is used up
          continue;
        }
        if (octal(head, 148, 8) !== checksum(head) || ![0, 48].includes(head[156])) throw damaged('a file header is broken');
        const size = octal(head, 124, 12);
        const name = new TextDecoder().decode(head.subarray(0, 100)).replace(/\0.*$/s, '');
        sink = await open(name, size);
        (left = size), (padding = tarPad(size).length);
        if (!size) await sink(null), (skip = 0);
      }
    }
  }
  if (!ended || left || skip) throw damaged('it is cut off');
}

// The only names a restore writes: the database and plain file names in files/ (never a path outside the data folder).
const allowed = (name) => name === 'contracts.db' || /^files\/(?!\.\.?$)[^/\\]+$/.test(name);

// Reads a backup and checks its shape: the manifest first, then exactly the entries it lists, each once and of the listed
// size. open(name, size, sha256, manifest) returns the sink for an entry (see readTar); the caller checks each SHA-256.
// Returns the manifest.
export async function readBackup(chunks, open) {
  let manifest;
  const seen = new Set();
  await readTar(chunks, async (name, size) => {
    if (!manifest) {
      if (name !== 'manifest.json' || size > 64 * 1024 * 1024) throw damaged('it does not start with a manifest');
      const parts = [];
      return async (piece) => {
        if (piece) return void parts.push(piece.slice());
        try {
          // fatal: a damaged byte in the text is an error, not a replacement character. (The manifest has no checksum of its
          // own; a change that still reads fine can only alter what it says about itself, as every entry is checked.)
          manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await new Blob(parts).arrayBuffer()));
        } catch {
          throw damaged('its manifest is unreadable');
        }
        if (manifest?.app !== 'Contract Desk' || !Number.isInteger(manifest.format) || manifest.format < 1 || !manifest.files?.['contracts.db']) {
          throw damaged('its manifest is not a Contract Desk one');
        }
        // Every name checked before anything is read or written for it: nothing outside the data folder, ever.
        for (const [name, f] of Object.entries(manifest.files)) {
          if (!allowed(name) || !Number.isInteger(f?.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(f.sha256)) throw damaged(`${name} is not a file it may hold`);
        }
        if (manifest.format > BACKUP_FORMAT) throw new HttpError(400, 'This backup was made by a newer version of Contract Desk. Update the app, then restore it. Nothing was changed.');
      };
    }
    const want = Object.hasOwn(manifest.files, name) && manifest.files[name];
    if (!want || !allowed(name) || seen.has(name) || want.size !== size) throw damaged(`${name} is not as listed`);
    seen.add(name);
    return open(name, size, want.sha256, manifest);
  });
  const missing = Object.keys(manifest?.files || {}).filter((n) => !seen.has(n));
  if (!manifest || missing.length) throw damaged(`${missing.length} listed file(s) are missing`);
  return manifest;
}

// SHA-256 fed piece by piece, for checking a restore on the phone as it streams (crypto.subtle only hashes a whole
// buffer at once, and node:crypto is not there). Standard FIPS 180-4.
const K = Uint32Array.from(
  '428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'
    .split(' ')
    .map((h) => parseInt(h, 16)),
);
export function sha256Hasher() {
  const H = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const block = new Uint8Array(64);
  let used = 0;
  let total = 0;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function compress(b, at) {
    for (let t = 0; t < 16; t++) W[t] = (b[at + 4 * t] << 24) | (b[at + 4 * t + 1] << 16) | (b[at + 4 * t + 2] << 8) | b[at + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = W[t - 16] + s0 + W[t - 7] + s1;
    }
    let [a, b2, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b2) ^ (a & c) ^ (b2 & c))) | 0;
      (h = g), (g = f), (f = e), (e = (d + t1) | 0), (d = c), (c = b2), (b2 = a), (a = (t1 + t2) | 0);
    }
    [a, b2, c, d, e, f, g, h].forEach((v, i) => (H[i] += v));
  }
  const hasher = {
    update(bytes) {
      total += bytes.length;
      let i = 0;
      if (used) {
        i = Math.min(64 - used, bytes.length);
        block.set(bytes.subarray(0, i), used);
        used += i;
        if (used < 64) return hasher;
        compress(block, 0);
        used = 0;
      }
      for (; i + 64 <= bytes.length; i += 64) compress(bytes, i);
      block.set(bytes.subarray(i), 0);
      used = bytes.length - i;
      return hasher;
    },
    hex() {
      const bits = total * 8;
      const tail = new Uint8Array((used < 56 ? 64 : 128) - used);
      tail[0] = 0x80;
      const v = new DataView(tail.buffer);
      v.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
      v.setUint32(tail.length - 4, bits >>> 0);
      hasher.update(tail);
      return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
    },
  };
  return hasher;
}
