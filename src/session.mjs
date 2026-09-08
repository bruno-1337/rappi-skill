import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export function sessionConfiguration() {
  const home = path.resolve(process.env.RAPPI_CONNECTOR_HOME || (
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'RappiConnector')
      : path.join(homedir(), '.rappi-connector')
  ));
  return { home, sessionFile: path.join(home, 'session.dpapi') };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

export async function dpapi(mode, input) {
  if (process.platform !== 'win32') throw new Error('Encrypted session storage currently requires Windows DPAPI.');
  if (!['protect', 'unprotect'].includes(mode)) throw new Error('Invalid DPAPI operation.');
  const operation = mode === 'protect'
    ? '[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)'
    : '[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)';
  const script = mode === 'protect'
    ? `Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($raw);[Console]::Out.Write([Convert]::ToBase64String(${operation}))`
    : `Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd();$bytes=[Convert]::FromBase64String($raw);[Console]::Out.Write([Text.Encoding]::UTF8.GetString(${operation}))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`Windows session encryption failed (${code}): ${stderr.trim()}`)));
    child.stdin.end(input);
  });
}

function validateSession(session) {
  if (session?.version !== 1 || typeof session.headers?.authorization !== 'string' || !session.headers.authorization.startsWith('Bearer ') || typeof session.headers?.deviceid !== 'string' || !session.headers.deviceid) {
    throw new Error('Saved API session is invalid. Run auth login again.');
  }
  return session;
}

export async function saveSession(headers, config = sessionConfiguration(), transform = dpapi) {
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

export async function loadSession(config = sessionConfiguration(), transform = dpapi) {
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
    throw new Error('Saved API session cannot be decrypted for this Windows user. Run auth login again.');
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
