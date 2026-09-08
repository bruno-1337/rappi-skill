import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export function sessionConfiguration({
  platform = process.platform,
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  const linuxStateHome = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : path.join(homeDirectory, '.local', 'state');
  const defaultHome = platform === 'win32'
    ? path.join(env.LOCALAPPDATA || homeDirectory, 'RappiConnector')
    : platform === 'darwin'
      ? path.join(homeDirectory, 'Library', 'Application Support', 'RappiConnector')
      : path.join(linuxStateHome, 'rappi-connector');
  const home = path.resolve(env.RAPPI_CONNECTOR_HOME || defaultHome);
  return { home, sessionFile: path.join(home, 'session.dpapi') };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

const KEY_SERVICE = 'com.rappi-skill.local-encryption';
const KEY_ACCOUNT = 'local-encryption-key-v1';
const ENVELOPE_PREFIX = 'rappi-aes-gcm-v1:';
const MAX_HELPER_OUTPUT = 2 * 1024 * 1024;

function runCredentialCommand(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks = [];
    let size = 0;
    let overflow = false;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_HELPER_OUTPUT) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', error => {
      if (error.code === 'ENOENT') reject(new Error(`Required credential helper is unavailable: ${command}.`));
      else reject(new Error(`Credential helper could not start: ${command}.`));
    });
    child.once('close', code => {
      if (overflow) reject(new Error('Credential helper returned too much data.'));
      else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function decodeMasterKey(value) {
  const encoded = String(value ?? '').trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('OS credential store returned an invalid encryption key.');
  return key;
}

async function macOSMasterKey(runCommand) {
  const lookup = () => runCommand('/usr/bin/security', [
    'find-generic-password', '-a', KEY_ACCOUNT, '-s', KEY_SERVICE, '-w',
  ]);
  let result = await lookup();
  if (result.code === 0) return decodeMasterKey(result.stdout);
  if (result.code !== 44) throw new Error(`macOS Keychain lookup failed (${result.code}).`);
  const generated = randomBytes(32).toString('base64');
  const command = `add-generic-password -U -a "${KEY_ACCOUNT}" -s "${KEY_SERVICE}" -w "${generated}"`;
  result = await runCommand('/usr/bin/security', ['-i'], `${command}\n`);
  if (result.code !== 0) throw new Error(`macOS Keychain write failed (${result.code}).`);
  result = await lookup();
  if (result.code !== 0) throw new Error(`macOS Keychain verification failed (${result.code}).`);
  return decodeMasterKey(result.stdout);
}

async function linuxMasterKey(runCommand) {
  const attributes = ['service', KEY_SERVICE, 'account', KEY_ACCOUNT];
  const lookup = () => runCommand('secret-tool', ['lookup', ...attributes]);
  let result = await lookup();
  if (result.code === 0 && result.stdout.trim()) return decodeMasterKey(result.stdout);
  if (![0, 1].includes(result.code)) throw new Error(`Linux Secret Service lookup failed (${result.code}).`);

  const generated = randomBytes(32).toString('base64');
  result = await runCommand('secret-tool', ['store', '--label=Rappi Skill local encryption', ...attributes], generated);
  if (result.code !== 0) throw new Error(`Linux Secret Service write failed (${result.code}).`);
  result = await lookup();
  if (result.code !== 0) throw new Error(`Linux Secret Service verification failed (${result.code}).`);
  return decodeMasterKey(result.stdout);
}

function encryptWithKey(input, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ENVELOPE_PREFIX));
  const ciphertext = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]);
  const envelope = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}`;
}

function decryptWithKey(input, key) {
  if (!input.startsWith(ENVELOPE_PREFIX)) throw new Error('Protected data format is invalid.');
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(input.slice(ENVELOPE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Protected data envelope is invalid.');
  }
  if (!envelope || typeof envelope !== 'object'
      || !['iv', 'tag', 'data'].every(field => typeof envelope[field] === 'string')) {
    throw new Error('Protected data envelope is invalid.');
  }
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Protected data envelope is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(ENVELOPE_PREFIX));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function windowsProtection(mode, input, runCommand) {
  const operation = mode === 'protect'
    ? '[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)'
    : '[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)';
  const script = mode === 'protect'
    ? `Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($raw);[Console]::Out.Write([Convert]::ToBase64String(${operation}))`
    : `Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($raw);[Console]::Out.Write([Text.Encoding]::UTF8.GetString(${operation}))`;
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);
  if (result.code !== 0) throw new Error(`Windows session encryption failed (${result.code}).`);
  return result.stdout;
}

export async function protectLocalData(mode, input, {
  platform = process.platform,
  runCommand = runCredentialCommand,
} = {}) {
  if (!['protect', 'unprotect'].includes(mode)) throw new Error('Invalid local protection operation.');
  if (typeof input !== 'string') throw new Error('Local protection input must be a string.');
  if (platform === 'win32') return windowsProtection(mode, input, runCommand);
  const key = platform === 'darwin'
    ? await macOSMasterKey(runCommand)
    : platform === 'linux'
      ? await linuxMasterKey(runCommand)
      : null;
  if (!key) throw new Error(`Encrypted local storage is unsupported on ${platform}.`);
  try {
    return mode === 'protect' ? encryptWithKey(input, key) : decryptWithKey(input, key);
  } finally {
    key.fill(0);
  }
}

function validateSession(session) {
  if (session?.version !== 1 || typeof session.headers?.authorization !== 'string' || !session.headers.authorization.startsWith('Bearer ') || typeof session.headers?.deviceid !== 'string' || !session.headers.deviceid) {
    throw new Error('Saved API session is invalid. Run auth login again.');
  }
  return session;
}

export async function saveSession(headers, config = sessionConfiguration(), transform = protectLocalData) {
  const session = validateSession({ version: 1, saved_at: Date.now(), headers });
  const protectedValue = await transform('protect', JSON.stringify(session));
  await privateDirectory(config.home);
  const temporary = `${config.sessionFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, protectedValue, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, config.sessionFile);
  } finally {
    await rm(temporary, { force: true });
  }
  return { saved_at: session.saved_at };
}

export async function loadSession(config = sessionConfiguration(), transform = protectLocalData) {
  let protectedValue;
  try { protectedValue = await readFile(config.sessionFile, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('No saved API session. Run auth login.');
    throw error;
  }
  try {
    return validateSession(JSON.parse(await transform('unprotect', protectedValue)));
  } catch (error) {
    if (/Saved API session/.test(error.message)) throw error;
    throw new Error('Saved API session cannot be decrypted for this OS user. Run auth login again.');
  }
}

export async function deleteSession(config = sessionConfiguration()) {
  await rm(config.sessionFile, { force: true });
}

export async function sessionStatus(config = sessionConfiguration()) {
  try {
    const session = await loadSession(config);
    return { saved: true, saved_at: session.saved_at };
  } catch (error) {
    if (/No saved API session/.test(error.message)) return { saved: false };
    throw error;
  }
}
