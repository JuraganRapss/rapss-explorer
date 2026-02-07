#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { normalizeClnNetwork } from '../src/ln/cln.js';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultComposeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
lnctl (Lightning operator tool; Core Lightning / CLN only)

Global flags:
  --backend <cli|docker>             (default: cli)
  --network <bitcoin|testnet|regtest|signet> (default: regtest) (aliases: mainnet->bitcoin)

Docker backend flags:
  --compose-file <path>             (default: dev/ln-regtest/docker-compose.yml)
  --service <name>                  (required for docker backend)

CLI backend flags:
  --cli-bin <path>                  (default: lightning-cli)

Commands:
  info
  newaddr
  listfunds
  balance
  connect --peer <nodeid@host:port>
  fundchannel --node-id <hex> --amount-sats <n>
  invoice --msat <amountmsat> --label <label> --desc <text> [--expiry <sec>]
  decodepay --bolt11 <invoice>
  pay --bolt11 <invoice>
  pay-status --payment-hash <hex32>
  preimage-get --payment-hash <hex32>
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

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function normalizeHex32(value, label) {
  const hex = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) die(`${label} must be 32-byte hex`);
  return hex;
}

async function lnCli({ backend, composeFile, service, network, cliBin, args }) {
  const useDocker = backend === 'docker';
  const cmd = useDocker ? 'docker' : (cliBin || 'lightning-cli');
  const fullArgs = useDocker
    ? ['compose', '-f', composeFile, 'exec', '-T', service, 'lightning-cli', `--network=${network}`, ...args]
    : [`--network=${network}`, ...args];

  try {
    const { stdout } = await execFileP(cmd, fullArgs, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 50 });
    const text = String(stdout || '').trim();
    try {
      return JSON.parse(text);
    } catch (_e) {
      return { result: text };
    }
  } catch (err) {
    const code = err?.code;
    const stderr = String(err?.stderr || '').trim();
    const stdout = String(err?.stdout || '').trim();
    const msg = stderr || stdout || err?.message || String(err);
    const e = new Error(msg);
    e.code = code;
    throw e;
  }
}

function sumMsatFromFunds(listfunds) {
  const outs = Array.isArray(listfunds?.outputs) ? listfunds.outputs : [];
  const chans = Array.isArray(listfunds?.channels) ? listfunds.channels : [];

  const toMsatBig = (v) => {
    if (v === null || v === undefined) return 0n;
    const s = typeof v === 'string' ? v : String(v);
    // CLN encodes amounts like "1234msat".
    const m = s.trim().match(/^([0-9]+)msat$/);
    if (m) return BigInt(m[1]);
    // Some fields may be sats already.
    if (/^[0-9]+$/.test(s.trim())) return BigInt(s.trim());
    return 0n;
  };

  let onchainConfirmed = 0n;
  let onchainUnconfirmed = 0n;
  for (const o of outs) {
    const msat = toMsatBig(o?.amount_msat ?? o?.amount ?? o?.value ?? 0);
    const st = String(o?.status || '').toLowerCase();
    if (st === 'confirmed') onchainConfirmed += msat;
    else onchainUnconfirmed += msat;
  }

  let channelTotal = 0n;
  for (const c of chans) {
    const msat = toMsatBig(c?.our_amount_msat ?? c?.our_amount ?? 0);
    channelTotal += msat;
  }

  return { onchainConfirmed, onchainUnconfirmed, channelTotal };
}

async function listPaysMaybe({ backend, composeFile, service, network, cliBin, paymentHashHex }) {
  // CLN versions differ; try listpays first, then listsendpays.
  try {
    return await lnCli({ backend, composeFile, service, network, cliBin, args: ['listpays', paymentHashHex] });
  } catch (_e) {}
  try {
    return await lnCli({ backend, composeFile, service, network, cliBin, args: ['listsendpays', paymentHashHex] });
  } catch (err) {
    throw err;
  }
}

function extractPreimageHex(paysRes) {
  const pays = Array.isArray(paysRes?.pays) ? paysRes.pays : Array.isArray(paysRes?.payments) ? paysRes.payments : [];
  for (const p of pays) {
    const cand =
      p?.preimage ||
      p?.payment_preimage ||
      p?.payment_preimage_hex ||
      p?.preimage_hex;
    if (typeof cand === 'string' && /^[0-9a-f]{64}$/i.test(cand.trim())) return cand.trim().toLowerCase();
  }
  return null;
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const backend = (flags.get('backend') && String(flags.get('backend')).trim()) || 'cli';
  if (backend !== 'cli' && backend !== 'docker') die('Invalid --backend (expected cli|docker)');
  const networkRaw = (flags.get('network') && String(flags.get('network')).trim()) || 'regtest';
  let network;
  try {
    network = normalizeClnNetwork(networkRaw);
  } catch (err) {
    die(err?.message ?? String(err));
  }

  const composeFile = (flags.get('compose-file') && String(flags.get('compose-file')).trim()) || defaultComposeFile;
  const service = flags.get('service') ? String(flags.get('service')).trim() : '';
  const cliBin = flags.get('cli-bin') ? String(flags.get('cli-bin')).trim() : '';

  if (backend === 'docker' && !service) die('Missing --service (required for --backend docker)');

  if (cmd === 'info') {
    const info = await lnCli({ backend, composeFile, service, network, cliBin, args: ['getinfo'] });
    process.stdout.write(`${JSON.stringify({ type: 'info', info }, null, 2)}\n`);
    return;
  }

  if (cmd === 'newaddr') {
    const r = await lnCli({ backend, composeFile, service, network, cliBin, args: ['newaddr'] });
    process.stdout.write(`${JSON.stringify({ type: 'newaddr', ...r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'listfunds') {
    const r = await lnCli({ backend, composeFile, service, network, cliBin, args: ['listfunds'] });
    process.stdout.write(`${JSON.stringify({ type: 'listfunds', ...r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'balance') {
    const funds = await lnCli({ backend, composeFile, service, network, cliBin, args: ['listfunds'] });
    const sums = sumMsatFromFunds(funds);
    process.stdout.write(`${JSON.stringify({
      type: 'balance',
      onchain_confirmed_msat: sums.onchainConfirmed.toString(),
      onchain_unconfirmed_msat: sums.onchainUnconfirmed.toString(),
      channel_total_msat: sums.channelTotal.toString(),
      raw: funds,
    }, null, 2)}\n`);
    return;
  }

  if (cmd === 'connect') {
    const peer = requireFlag(flags, 'peer');
    const r = await lnCli({ backend, composeFile, service, network, cliBin, args: ['connect', peer] });
    process.stdout.write(`${JSON.stringify({ type: 'connect', peer, result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'fundchannel') {
    const nodeId = requireFlag(flags, 'node-id');
    const amountSats = parseIntFlag(requireFlag(flags, 'amount-sats'), 'amount-sats');
    if (!Number.isFinite(amountSats) || amountSats <= 0) die('Invalid --amount-sats');
    const r = await lnCli({ backend, composeFile, service, network, cliBin, args: ['fundchannel', nodeId, String(amountSats)] });
    process.stdout.write(`${JSON.stringify({ type: 'fundchannel', node_id: nodeId, amount_sats: amountSats, result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'invoice') {
    const msat = requireFlag(flags, 'msat');
    const label = requireFlag(flags, 'label');
    const desc = requireFlag(flags, 'desc');
    const expiry = flags.get('expiry') ? parseIntFlag(flags.get('expiry'), 'expiry') : null;
    const cliArgs = ['invoice', msat, label, desc];
    if (expiry !== null) cliArgs.push(String(expiry));
    const r = await lnCli({ backend, composeFile, service, network, cliBin, args: cliArgs });
    process.stdout.write(`${JSON.stringify({ type: 'invoice', ...r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'decodepay') {
    const bolt11 = requireFlag(flags, 'bolt11');
    const r = await lnCli({ backend, composeFile, service, network, cliBin, args: ['decodepay', bolt11] });
    process.stdout.write(`${JSON.stringify({ type: 'decodepay', ...r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'pay') {
    const bolt11 = requireFlag(flags, 'bolt11');
    const r = await lnCli({ backend, composeFile, service, network, cliBin, args: ['pay', bolt11] });
    process.stdout.write(`${JSON.stringify({ type: 'pay', ...r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'pay-status') {
    const hash = normalizeHex32(requireFlag(flags, 'payment-hash'), 'payment-hash');
    const r = await listPaysMaybe({ backend, composeFile, service, network, cliBin, paymentHashHex: hash });
    process.stdout.write(`${JSON.stringify({ type: 'pay_status', payment_hash_hex: hash, result: r }, null, 2)}\n`);
    return;
  }

  if (cmd === 'preimage-get') {
    const hash = normalizeHex32(requireFlag(flags, 'payment-hash'), 'payment-hash');
    const r = await listPaysMaybe({ backend, composeFile, service, network, cliBin, paymentHashHex: hash });
    const preimageHex = extractPreimageHex(r);
    process.stdout.write(`${JSON.stringify({ type: 'preimage', payment_hash_hex: hash, preimage_hex: preimageHex, result: r }, null, 2)}\n`);
    return;
  }

  die(`Unknown command: ${cmd}`);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
