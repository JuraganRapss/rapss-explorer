import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { Keypair } from '@solana/web3.js';

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseHexBytes(hex, { len, label }) {
  const h = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(h) || h.length % 2 !== 0) throw new Error(`${label} must be hex`);
  const buf = Buffer.from(h, 'hex');
  if (len !== undefined && buf.length !== len) throw new Error(`${label} must be ${len} bytes`);
  return new Uint8Array(buf);
}

export function readSolanaKeypair(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (_e) {
    throw new Error('Invalid Solana keypair JSON');
  }
  if (!Array.isArray(arr)) throw new Error('Solana keypair must be a JSON array');
  const bytes = Uint8Array.from(arr);
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(`Solana keypair must be 64 bytes (solana-keygen) or 32 bytes (seed), got ${bytes.length}`);
  }
  return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
}

export function generateSolanaKeypair({ seedHex = null } = {}) {
  if (seedHex) {
    const seed = parseHexBytes(seedHex, { len: 32, label: 'seedHex' });
    return Keypair.fromSeed(seed);
  }
  return Keypair.fromSeed(randomBytes(32));
}

export function writeSolanaKeypair(filePath, keypair, { overwrite = false } = {}) {
  const outPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  mkdirp(path.dirname(outPath));

  if (!overwrite && fs.existsSync(outPath)) throw new Error(`Refusing to overwrite existing keypair: ${outPath}`);

  const bytes = keypair?.secretKey;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) throw new Error('Invalid keypair');
  fs.writeFileSync(outPath, `${JSON.stringify(Array.from(bytes))}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(outPath, 0o600);
  } catch (_e) {}
  return outPath;
}

