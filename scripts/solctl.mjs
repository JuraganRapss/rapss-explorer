#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
  mintTo,
  transfer,
} from '@solana/spl-token';

import {
  generateSolanaKeypair,
  readSolanaKeypair,
  writeSolanaKeypair,
} from '../src/solana/keypair.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
solctl (Solana wallet + inventory operator tool; local keypairs only)

Global flags:
  --rpc-url <url>                    (default: http://127.0.0.1:8899)
  --commitment <processed|confirmed|finalized> (default: confirmed)

Commands:
  keygen --out <path> [--seed-hex <hex32>] [--force 0|1]
  address --keypair <path>
  balance --keypair <path>
  airdrop --keypair <path> --sol <n>
  transfer-sol --keypair <path> --to <pubkey> --sol <n>
  mint-create --keypair <path> --decimals <n> [--out <path>]
  mint-info --mint <pubkey>
  token-ata --keypair <path> --mint <pubkey> [--owner <pubkey>] [--create 0|1]
  token-balance --keypair <path> --mint <pubkey> [--owner <pubkey>]
  token-transfer --keypair <path> --mint <pubkey> --to <pubkey> --amount <u64> [--create-ata 0|1]
  mint-to --keypair <path> --mint <pubkey> --to <pubkey> --amount <u64> [--create-ata 0|1]
  inventory --keypair <path> [--mints <csvPubkeys>]

Notes:
  - All private keys must live under onchain/ (gitignored).
  - Amounts are atomic units (u64) for SPL token ops.
`.trim();
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function parseU64(value, label) {
  try {
    const x = BigInt(String(value).trim());
    if (x < 0n) die(`Invalid ${label} (negative)`);
    if (x > 0xffffffffffffffffn) die(`Invalid ${label} (too large)`);
    return x;
  } catch (_e) {
    die(`Invalid ${label}`);
  }
}

function parseSol(value, label) {
  const n = Number.parseFloat(String(value));
  if (!Number.isFinite(n) || n <= 0) die(`Invalid ${label}`);
  return n;
}

function toPubkey(value, label) {
  try {
    return new PublicKey(String(value || '').trim());
  } catch (_e) {
    die(`Invalid ${label}`);
  }
}

async function sendAndConfirm(connection, tx, { commitment }) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, commitment);
  if (conf?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function ensureAta({ connection, payer, mint, owner, commitment }) {
  const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  try {
    await getAccount(connection, ata, commitment);
    return { ata, created: false };
  } catch (_e) {}

  const ix = createAssociatedTokenAccountInstruction(
    payer.publicKey,
    ata,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const latest = await connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = latest.blockhash;
  tx.sign(payer);
  const sig = await sendAndConfirm(connection, tx, { commitment });
  return { ata, created: true, tx_sig: sig };
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const rpcUrl = (flags.get('rpc-url') && String(flags.get('rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const commitment = (flags.get('commitment') && String(flags.get('commitment')).trim()) || 'confirmed';

  if (cmd === 'keygen') {
    const out = requireFlag(flags, 'out');
    const seedHex = flags.get('seed-hex') ? String(flags.get('seed-hex')).trim() : null;
    const force = parseBool(flags.get('force'), false);
    const kp = generateSolanaKeypair({ seedHex });
    const outPath = writeSolanaKeypair(out, kp, { overwrite: force });
    process.stdout.write(`${JSON.stringify({ type: 'keygen', out: outPath, pubkey: kp.publicKey.toBase58() }, null, 2)}\n`);
    return;
  }

  if (cmd === 'address') {
    const keypairPath = requireFlag(flags, 'keypair');
    const kp = readSolanaKeypair(keypairPath);
    process.stdout.write(`${JSON.stringify({ type: 'address', pubkey: kp.publicKey.toBase58() }, null, 2)}\n`);
    return;
  }

  if (cmd === 'balance') {
    const keypairPath = requireFlag(flags, 'keypair');
    const kp = readSolanaKeypair(keypairPath);
    const connection = new Connection(rpcUrl, commitment);
    const lamports = await connection.getBalance(kp.publicKey, commitment);
    process.stdout.write(`${JSON.stringify({ type: 'balance', pubkey: kp.publicKey.toBase58(), lamports, sol: lamports / 1e9 }, null, 2)}\n`);
    return;
  }

  if (cmd === 'airdrop') {
    const keypairPath = requireFlag(flags, 'keypair');
    const sol = parseSol(requireFlag(flags, 'sol'), 'sol');
    const kp = readSolanaKeypair(keypairPath);
    const connection = new Connection(rpcUrl, commitment);
    const sig = await connection.requestAirdrop(kp.publicKey, Math.round(sol * 1e9));
    await connection.confirmTransaction(sig, commitment);
    process.stdout.write(`${JSON.stringify({ type: 'airdrop', pubkey: kp.publicKey.toBase58(), sol, tx_sig: sig }, null, 2)}\n`);
    return;
  }

  if (cmd === 'transfer-sol') {
    const keypairPath = requireFlag(flags, 'keypair');
    const to = toPubkey(requireFlag(flags, 'to'), 'to');
    const sol = parseSol(requireFlag(flags, 'sol'), 'sol');
    const payer = readSolanaKeypair(keypairPath);
    const connection = new Connection(rpcUrl, commitment);

    const ix = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports: Math.round(sol * 1e9),
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    const latest = await connection.getLatestBlockhash(commitment);
    tx.recentBlockhash = latest.blockhash;
    tx.sign(payer);
    const sig = await sendAndConfirm(connection, tx, { commitment });
    process.stdout.write(`${JSON.stringify({ type: 'transfer_sol', from: payer.publicKey.toBase58(), to: to.toBase58(), sol, tx_sig: sig }, null, 2)}\n`);
    return;
  }

  if (cmd === 'mint-create') {
    const keypairPath = requireFlag(flags, 'keypair');
    const decimals = parseIntFlag(requireFlag(flags, 'decimals'), 'decimals');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) die('Invalid --decimals (0..18)');
    const out = flags.get('out') ? String(flags.get('out')).trim() : '';
    const payer = readSolanaKeypair(keypairPath);
    const connection = new Connection(rpcUrl, commitment);

    // Mint keypair is generated locally and can optionally be written out.
    const mintKp = Keypair.generate();
    const mint = await createMint(connection, payer, payer.publicKey, payer.publicKey, decimals, mintKp);
    let mintKeypairPath = null;
    if (out) {
      const p = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `${JSON.stringify(Array.from(mintKp.secretKey))}\n`, { mode: 0o600 });
      try { fs.chmodSync(p, 0o600); } catch (_e) {}
      mintKeypairPath = p;
    }
    process.stdout.write(`${JSON.stringify({ type: 'mint_created', mint: mint.toBase58(), decimals, mint_keypair: mintKeypairPath }, null, 2)}\n`);
    return;
  }

  if (cmd === 'mint-info') {
    const mint = toPubkey(requireFlag(flags, 'mint'), 'mint');
    const connection = new Connection(rpcUrl, commitment);
    const info = await getMint(connection, mint, commitment);
    process.stdout.write(`${JSON.stringify({
      type: 'mint_info',
      mint: mint.toBase58(),
      decimals: info.decimals,
      supply: info.supply.toString(),
      mintAuthority: info.mintAuthority ? info.mintAuthority.toBase58() : null,
      freezeAuthority: info.freezeAuthority ? info.freezeAuthority.toBase58() : null,
    }, null, 2)}\n`);
    return;
  }

  if (cmd === 'token-ata') {
    const keypairPath = requireFlag(flags, 'keypair');
    const mint = toPubkey(requireFlag(flags, 'mint'), 'mint');
    const payer = readSolanaKeypair(keypairPath);
    const owner = flags.get('owner') ? toPubkey(String(flags.get('owner')).trim(), 'owner') : payer.publicKey;
    const create = parseBool(flags.get('create'), true);
    const connection = new Connection(rpcUrl, commitment);

    const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    let exists = true;
    try {
      await getAccount(connection, ata, commitment);
    } catch (_e) {
      exists = false;
    }
    if (!exists && create) {
      const r = await ensureAta({ connection, payer, mint, owner, commitment });
      process.stdout.write(`${JSON.stringify({ type: 'token_ata', mint: mint.toBase58(), owner: owner.toBase58(), ata: r.ata.toBase58(), created: r.created, tx_sig: r.tx_sig || null }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ type: 'token_ata', mint: mint.toBase58(), owner: owner.toBase58(), ata: ata.toBase58(), created: false, exists }, null, 2)}\n`);
    return;
  }

  if (cmd === 'token-balance') {
    const keypairPath = requireFlag(flags, 'keypair');
    const mint = toPubkey(requireFlag(flags, 'mint'), 'mint');
    const payer = readSolanaKeypair(keypairPath);
    const owner = flags.get('owner') ? toPubkey(String(flags.get('owner')).trim(), 'owner') : payer.publicKey;
    const connection = new Connection(rpcUrl, commitment);
    const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    let amount = 0n;
    let exists = true;
    try {
      const acc = await getAccount(connection, ata, commitment);
      amount = acc.amount;
    } catch (_e) {
      exists = false;
    }
    process.stdout.write(`${JSON.stringify({ type: 'token_balance', mint: mint.toBase58(), owner: owner.toBase58(), ata: ata.toBase58(), exists, amount: amount.toString() }, null, 2)}\n`);
    return;
  }

  if (cmd === 'token-transfer') {
    const keypairPath = requireFlag(flags, 'keypair');
    const mint = toPubkey(requireFlag(flags, 'mint'), 'mint');
    const to = toPubkey(requireFlag(flags, 'to'), 'to');
    const amount = parseU64(requireFlag(flags, 'amount'), 'amount');
    const createAta = parseBool(flags.get('create-ata'), true);
    const payer = readSolanaKeypair(keypairPath);
    const connection = new Connection(rpcUrl, commitment);

    const fromAta = await getAssociatedTokenAddress(mint, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const toAta = await getAssociatedTokenAddress(mint, to, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    if (createAta) {
      await ensureAta({ connection, payer, mint, owner: to, commitment });
    }
    const sig = await transfer(connection, payer, fromAta, toAta, payer.publicKey, amount, [], { commitment });
    process.stdout.write(`${JSON.stringify({ type: 'token_transfer', mint: mint.toBase58(), from: payer.publicKey.toBase58(), to: to.toBase58(), amount: amount.toString(), tx_sig: sig }, null, 2)}\n`);
    return;
  }

  if (cmd === 'mint-to') {
    const keypairPath = requireFlag(flags, 'keypair');
    const mint = toPubkey(requireFlag(flags, 'mint'), 'mint');
    const to = toPubkey(requireFlag(flags, 'to'), 'to');
    const amount = parseU64(requireFlag(flags, 'amount'), 'amount');
    const createAta = parseBool(flags.get('create-ata'), true);
    const payer = readSolanaKeypair(keypairPath);
    const connection = new Connection(rpcUrl, commitment);

    const toAta = await getAssociatedTokenAddress(mint, to, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    if (createAta) {
      await ensureAta({ connection, payer, mint, owner: to, commitment });
    }
    const sig = await mintTo(connection, payer, mint, toAta, payer.publicKey, amount, [], { commitment });
    process.stdout.write(`${JSON.stringify({ type: 'mint_to', mint: mint.toBase58(), to: to.toBase58(), amount: amount.toString(), tx_sig: sig }, null, 2)}\n`);
    return;
  }

  if (cmd === 'inventory') {
    const keypairPath = requireFlag(flags, 'keypair');
    const mintsRaw = flags.get('mints') ? String(flags.get('mints')).trim() : '';
    const mints = mintsRaw
      ? mintsRaw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => toPubkey(s, 'mint'))
      : [];
    const payer = readSolanaKeypair(keypairPath);
    const connection = new Connection(rpcUrl, commitment);
    const lamports = await connection.getBalance(payer.publicKey, commitment);

    const tokenBalances = [];
    for (const mint of mints) {
      const ata = await getAssociatedTokenAddress(mint, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      let amount = 0n;
      let exists = true;
      try {
        const acc = await getAccount(connection, ata, commitment);
        amount = acc.amount;
      } catch (_e) {
        exists = false;
      }
      tokenBalances.push({ mint: mint.toBase58(), ata: ata.toBase58(), exists, amount: amount.toString() });
    }

    process.stdout.write(`${JSON.stringify({
      type: 'inventory',
      pubkey: payer.publicKey.toBase58(),
      sol: { lamports, sol: lamports / 1e9 },
      tokens: tokenBalances,
    }, null, 2)}\n`);
    return;
  }

  die(`Unknown command: ${cmd}`);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));

