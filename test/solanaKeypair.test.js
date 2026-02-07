import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

import {
  generateSolanaKeypair,
  readSolanaKeypair,
  writeSolanaKeypair,
} from '../src/solana/keypair.js';

const execFileP = promisify(execFile);

const repoRoot = path.resolve(process.cwd());

async function nodeJson(args) {
  const { stdout } = await execFileP('node', args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 10 });
  const text = String(stdout || '').trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    throw new Error(`Failed to parse JSON: ${text.slice(0, 200)}`);
  }
}

test('solana keypair read/write helpers', async () => {
  const runId = crypto.randomBytes(4).toString('hex');
  const dir = path.join(repoRoot, 'onchain/solana/keypairs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `unit-solana-keypair-${runId}.json`);

  const seedHex = '00'.repeat(32);
  const kp = generateSolanaKeypair({ seedHex });
  const outPath = writeSolanaKeypair(out, kp);
  assert.equal(outPath, out);

  const got = readSolanaKeypair(out);
  assert.equal(got.publicKey.toBase58(), kp.publicKey.toBase58());

  let threw = false;
  try {
    writeSolanaKeypair(out, kp);
  } catch (_e) {
    threw = true;
  }
  assert.equal(threw, true, 'expected writeSolanaKeypair to refuse overwrite by default');

  const outPath2 = writeSolanaKeypair(out, kp, { overwrite: true });
  assert.equal(outPath2, out);
});

test('solctl keygen/address are deterministic with seed', async () => {
  const runId = crypto.randomBytes(4).toString('hex');
  const out = path.join(repoRoot, 'onchain/solana/keypairs', `unit-solctl-${runId}.json`);
  const seedHex = '11'.repeat(32);
  const expected = generateSolanaKeypair({ seedHex }).publicKey.toBase58();

  const r1 = await nodeJson(['scripts/solctl.mjs', 'keygen', '--out', out, '--seed-hex', seedHex, '--force', '1']);
  assert.equal(r1.type, 'keygen');
  assert.equal(r1.pubkey, expected);

  const r2 = await nodeJson(['scripts/solctl.mjs', 'address', '--keypair', out]);
  assert.equal(r2.type, 'address');
  assert.equal(r2.pubkey, expected);
});

