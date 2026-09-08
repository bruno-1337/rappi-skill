import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { protectLocalData, saveSession, loadSession, deleteSession, sessionConfiguration } from '../src/session.mjs';
import { prepareApproval, claimApproval, cancelApproval, canonicalDigest, checkoutContextHashes } from '../src/approval.mjs';

const transform = async (mode, value) => mode === 'protect'
  ? Buffer.from(value, 'utf8').toString('base64')
  : Buffer.from(value, 'base64').toString('utf8');

function memoryCredentialRunner(platform) {
  let stored = null;
  const calls = [];
  const runCommand = async (command, args, input = '') => {
    calls.push({ command, args: [...args], input });
    if (platform === 'darwin') {
      if (args[0] === 'find-generic-password') {
        return stored == null ? { code: 44, stdout: '' } : { code: 0, stdout: `${stored}\n` };
      }
      if (args[0] === '-i') {
        // Real `security -i` rejects `quit` with exit code 1; a plain write
        // succeeds and the process exits cleanly on stdin EOF.
        const lines = input.split('\n').filter(Boolean);
        if (lines.some(line => line === 'quit')) return { code: 1, stdout: '' };
        const write = lines.find(line => line.startsWith('add-generic-password'));
        if (!write) return { code: 1, stdout: '' };
        const match = write.match(/-w "([A-Za-z0-9+/=]+)"$/);
        if (!match) return { code: 1, stdout: '' };
        stored = match[1];
        return { code: 0, stdout: '' };
      }
      return { code: 1, stdout: '' };
    }
    if (args[0] === 'lookup') {
      return stored == null ? { code: 1, stdout: '' } : { code: 0, stdout: `${stored}\n` };
    }
    if (args[0] === 'store') {
      stored = input;
      return { code: 0, stdout: '' };
    }
    return { code: 2, stdout: '' };
  };
  return { calls, runCommand, stored: () => stored };
}

async function temporaryConfig() {
  const home = await mkdtemp(path.join(tmpdir(), 'rappi-test-'));
  return {
    home,
    sessionFile: path.join(home, 'session.dpapi'),
    approvals: path.join(home, 'approvals'),
  };
}

const snapshot = {
  store_type: 'market',
  stores: [{ id: '1', products: [{ id: '1_a', units: 1 }], final_total_centavos: 1000 }],
  final_total_centavos: 1000,
  address_id: '7', delivery_window: 'now', payment_method_id: 'visa-42',
  recalculation_hash: canonicalDigest({ total: 10 }).hash,
  tip_context_hash: canonicalDigest({ options: [] }).hash,
  payment_context_hash: canonicalDigest({ methods: ['visa-42'] }).hash,
};

test('session round-trips through injected protection and deletes cleanly', async () => {
  const config = await temporaryConfig();
  try {
    await saveSession({ authorization: 'Bearer fixture-value', deviceid: 'device-fixture' }, config, transform);
    assert.equal((await loadSession(config, transform)).headers.authorization, 'Bearer fixture-value');
    await deleteSession(config);
    await assert.rejects(() => loadSession(config, transform), /No saved API session/);
  } finally { await rm(config.home, { recursive: true, force: true }); }
});

test('macOS and Linux protect local data with OS-stored keys and authenticated encryption', async () => {
  for (const platform of ['darwin', 'linux']) {
    const credentials = memoryCredentialRunner(platform);
    const protectedValue = await protectLocalData('protect', 'sensitive fixture', {
      platform,
      runCommand: credentials.runCommand,
    });
    assert.match(protectedValue, /^rappi-aes-gcm-v1:/);
    assert.equal(protectedValue.includes('sensitive fixture'), false);
    assert.equal(await protectLocalData('unprotect', protectedValue, {
      platform,
      runCommand: credentials.runCommand,
    }), 'sensitive fixture');
    assert.equal(credentials.calls.some(call => call.args.includes(credentials.stored())), false);
    const replacement = protectedValue.endsWith('A') ? 'B' : 'A';
    await assert.rejects(() => protectLocalData('unprotect', `${protectedValue.slice(0, -1)}${replacement}`, {
      platform,
      runCommand: credentials.runCommand,
    }));
  }
});

test('session storage follows native per-user data locations', () => {
  assert.equal(sessionConfiguration({
    platform: 'darwin', env: {}, homeDirectory: '/users/fixture',
  }).home, path.resolve('/users/fixture', 'Library', 'Application Support', 'RappiConnector'));
  assert.equal(sessionConfiguration({
    platform: 'linux', env: {}, homeDirectory: '/home/fixture',
  }).home, path.resolve('/home/fixture', '.local', 'state', 'rappi-connector'));
  assert.equal(sessionConfiguration({
    platform: 'linux', env: { XDG_STATE_HOME: '/state' }, homeDirectory: '/home/fixture',
  }).home, path.resolve('/state', 'rappi-connector'));
  assert.equal(sessionConfiguration({
    platform: 'linux', env: { XDG_STATE_HOME: 'relative-state' }, homeDirectory: '/home/fixture',
  }).home, path.resolve('/home/fixture', '.local', 'state', 'rappi-connector'));
});

test('approval is atomic one-shot under concurrent claims', async () => {
  const config = await temporaryConfig();
  try {
    const approval = await prepareApproval(snapshot, config, transform);
    const outcomes = await Promise.allSettled([
      claimApproval(approval.approval_id, snapshot, config, transform),
      claimApproval(approval.approval_id, snapshot, config, transform),
    ]);
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(row => row.status === 'rejected').length, 1);
  } finally { await rm(config.home, { recursive: true, force: true }); }
});

test('changed checkout consumes approval without authorizing', async () => {
  const config = await temporaryConfig();
  try {
    const approval = await prepareApproval(snapshot, config, transform);
    await assert.rejects(() => claimApproval(approval.approval_id, { ...snapshot, final_total_centavos: 1001 }, config, transform), /Checkout changed/);
    await assert.rejects(() => claimApproval(approval.approval_id, snapshot, config, transform), /already consumed/);
  } finally { await rm(config.home, { recursive: true, force: true }); }
});

test('approval refuses embedded secrets', async () => {
  const config = await temporaryConfig();
  try {
    await assert.rejects(() => prepareApproval({ ...snapshot, authorization: 'Bearer fixture-value' }, config, transform), /Secret-bearing/);
  } finally { await rm(config.home, { recursive: true, force: true }); }
});

test('cancelling a nonexistent approval reports not found', async () => {
  const config = await temporaryConfig();
  try {
    await assert.rejects(() => cancelApproval('0123456789abcdef-00000000-0000-0000-0000-000000000000', config), /not found/);
  } finally { await rm(config.home, { recursive: true, force: true }); }
});

test('renewed checkout timestamp and challenge reference preserve one-shot approval', async () => {
  const config = await temporaryConfig();
  const rec = { timestamp: 1, total: 10, stores: [{ id: 1, products: [{ id: 'a', units: 1 }] }] };
  const payment = { list_cards: [{ charge_data: { threeds_reference_id: 'first', payment_method_token: 'token-fixture' } }] };
  const first = { ...snapshot, ...checkoutContextHashes(rec, payment, 'card-fixture', 0) };
  const next = { ...snapshot, ...checkoutContextHashes(
    { ...rec, timestamp: 2 },
    { list_cards: [{ charge_data: { threeds_reference_id: 'renewed', payment_method_token: 'token-fixture' } }] },
    'card-fixture', 0,
  ) };
  try {
    const approval = await prepareApproval(first, config, transform);
    assert.equal((await claimApproval(approval.approval_id, next, config, transform)).valid, true);
    await assert.rejects(() => claimApproval(approval.approval_id, next, config, transform), /already consumed/);
    assert.notDeepEqual(checkoutContextHashes({ ...rec, total: 11 }, payment, 'card-fixture', 0), checkoutContextHashes(rec, payment, 'card-fixture', 0));
    assert.notDeepEqual(checkoutContextHashes(rec, payment, 'other-card', 0), checkoutContextHashes(rec, payment, 'card-fixture', 0));
    assert.notDeepEqual(checkoutContextHashes(rec, payment, 'card-fixture', 100), checkoutContextHashes(rec, payment, 'card-fixture', 0));
  } finally { await rm(config.home, { recursive: true, force: true }); }
});
