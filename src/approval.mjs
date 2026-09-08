import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { dpapi, sessionConfiguration } from './session.mjs';

const VERSION = 1;
const TTL_MS = 10 * 60 * 1000;
const ID = /^[a-f0-9]{16}-[a-f0-9-]{36}$/;
const FORBIDDEN = /(?:authorization|bearer|token|cookie|deviceid|password|card.?number|security.?code|cvv|cvc)/i;

function canonicalize(value, location = 'snapshot', forbidSecrets = true) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonicalize(entry, `${location}[${index}]`, forbidSecrets));
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (forbidSecrets && FORBIDDEN.test(key)) throw new Error(`Secret-bearing field is forbidden at ${location}.${key}.`);
      output[key] = canonicalize(value[key], `${location}.${key}`, forbidSecrets);
    }
    return output;
  }
  throw new Error(`${location} contains an unsupported value.`);
}

export function canonicalDigest(value) {
  const canonical = JSON.stringify(canonicalize(value));
  return { canonical, hash: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}

export function opaqueHash(value) {
  const canonical = JSON.stringify(canonicalize(value, 'remote response', false));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function checkoutContextHashes(recalculation, paymentMethods, selectedPaymentId, tipCentavos) {
  // The service renews these challenge references on read; they are not payment choices.
  function paymentContext(value) {
    if (Array.isArray(value)) return value.map(paymentContext);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === 'charge_data' && child && typeof child === 'object' && !Array.isArray(child)) {
        const { threeds_reference_id, ...material } = child;
        return [key, paymentContext(material)];
      }
      return [key, paymentContext(child)];
    }));
  }
  const { timestamp, ...materialRecalculation } = recalculation;
  return {
    recalculation_hash: opaqueHash(materialRecalculation),
    payment_context_hash: opaqueHash({
      selected_payment_id: selectedPaymentId,
      resolver: paymentContext(paymentMethods),
    }),
    // Suggested tips and marketing copy do not authorize a tip; the selected amount does.
    tip_context_hash: opaqueHash({ tip_centavos: tipCentavos }),
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Approval snapshot must be an object.');
  for (const key of [
    'store_type', 'stores', 'final_total_centavos', 'address_id', 'delivery_window',
    'payment_method_id', 'recalculation_hash', 'tip_context_hash', 'payment_context_hash',
  ]) {
    if (!(key in snapshot)) throw new Error(`Approval snapshot is missing ${key}.`);
  }
  if (!Array.isArray(snapshot.stores) || !snapshot.stores.length) throw new Error('Approval snapshot must contain stores.');
  if (!Number.isSafeInteger(snapshot.final_total_centavos) || snapshot.final_total_centavos < 0) throw new Error('Approval final total must be nonnegative integer centavos.');
  for (const field of ['recalculation_hash', 'tip_context_hash', 'payment_context_hash']) {
    if (!/^[a-f0-9]{64}$/.test(snapshot[field])) throw new Error(`Approval ${field} is invalid.`);
  }
  return canonicalDigest(snapshot);
}

function approvalConfiguration() {
  const config = sessionConfiguration();
  return { ...config, approvals: path.join(config.home, 'approvals') };
}

function recordPath(config, id) {
  if (!ID.test(id)) throw new Error('Invalid approval ID.');
  return path.join(config.approvals, `${id}.dpapi`);
}

export async function prepareApproval(snapshot, config = approvalConfiguration(), transform = dpapi) {
  const { canonical, hash } = validateSnapshot(snapshot);
  const now = Date.now();
  const id = `${hash.slice(0, 16)}-${randomUUID()}`;
  const record = { version: VERSION, created_at: now, expires_at: now + TTL_MS, hash, canonical };
  const protectedValue = await transform('protect', JSON.stringify(record));
  await mkdir(config.approvals, { recursive: true, mode: 0o700 });
  await writeFile(recordPath(config, id), protectedValue, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { approval_id: id, short_hash: hash.slice(0, 12), expires_at: new Date(record.expires_at).toISOString() };
}

export async function claimApproval(id, snapshot, config = approvalConfiguration(), transform = dpapi) {
  const source = recordPath(config, id);
  const lock = `${source}.claim`;
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Approval is already being claimed or was interrupted.');
    throw error;
  }
  try {
    let protectedValue;
    try {
      protectedValue = await readFile(source, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Approval not found, expired, or already consumed.');
      throw error;
    }
    await rm(source, { force: true });
    const record = JSON.parse(await transform('unprotect', protectedValue));
    if (record.version !== VERSION || !Number.isFinite(record.expires_at) || Date.now() > record.expires_at) throw new Error('Approval expired.');
    const { canonical, hash } = validateSnapshot(snapshot);
    if (hash !== record.hash || canonical !== record.canonical) {
      const approved = JSON.parse(record.canonical);
      const changed = Object.keys(snapshot).filter(key =>
        JSON.stringify(approved[key]) !== JSON.stringify(snapshot[key])
      );
      throw new Error(`Checkout changed (${changed.join(', ')}); a new explicit approval is required.`);
    }
    return { valid: true, one_shot: true, hash };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function cancelApproval(id, config = approvalConfiguration()) {
  try {
    await rm(recordPath(config, id));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Approval not found, expired, or already consumed.');
    throw error;
  }
}
