export function normalizeClnNetwork(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) throw new Error('Missing lightning network');

  if (raw === 'bitcoin' || raw === 'mainnet' || raw === 'main' || raw === 'btc') return 'bitcoin';
  if (raw === 'testnet' || raw === 'test') return 'testnet';
  if (raw === 'regtest' || raw === 'reg') return 'regtest';
  if (raw === 'signet') return 'signet';

  throw new Error(`Unsupported CLN network: ${raw} (expected bitcoin|testnet|regtest|signet)`);
}

