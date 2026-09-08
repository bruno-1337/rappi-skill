#!/usr/bin/env bun
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { saveSession, sessionConfiguration } from '../src/session.mjs';
import { localDiagnostics } from '../src/diagnostics.mjs';

const OFFICIAL_URL = 'https://www.rappi.com.br/';
const command = process.argv[2] ?? '--help';

function configuration() {
  const session = sessionConfiguration();
  return {
    ...session,
    profile: path.join(session.home, 'profile'),
    authLock: path.join(session.home, 'auth.lock'),
    authOwner: path.join(session.home, 'auth.lock', 'owner.json'),
  };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function acquireAuthLock(config) {
  await privateDirectory(config.home);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(config.authLock, { mode: 0o700 });
      await writeFile(config.authOwner, JSON.stringify({ pid: process.pid }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(config.authOwner, 'utf8')); } catch { /* Incomplete crashed lock. */ }
      if (owner && alive(owner.pid)) throw new Error(`Another auth login is running (PID ${owner.pid}).`);
      await rm(config.authLock, { recursive: true, force: true });
    }
  }
  throw new Error('Could not acquire the authentication lock.');
}

async function chromium() {
  try { return (await import('playwright')).chromium; }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error('Playwright is not installed. Run "bun install && bun run setup".');
  }
}

async function authenticatedHeaders(page, { timeoutMs = 10 * 60 * 1000, signal } = {}) {
  const allowed = ['authorization', 'deviceid', 'x-application-id', 'app-version', 'accept-language', 'needappsflyerid', 'af-web-id', 'cybs-fp-id'];
  return new Promise((resolve, reject) => {
    let authSucceeded = false;
    let settled = false;
    let settleTimer;
    const merged = {};
    const timer = setTimeout(() => finish(new Error('Authentication timed out. Run auth login again.')), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      page.off('response', observe);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ accept: 'application/json', 'content-type': 'application/json', ...merged });
    }
    function abort() {
      finish(signal?.reason instanceof Error ? signal.reason : new Error('Authentication cancelled.'));
    }
    function observe(response) {
      try {
        const url = new URL(response.url());
        const headers = response.request().headers();
        if (url.hostname !== 'services.rappi.com.br' || response.status() < 200 || response.status() >= 300
            || !headers.authorization || !headers.deviceid) return;
        for (const name of allowed) if (headers[name]) merged[name] = headers[name];
        if (!authSucceeded && url.pathname === '/ms/application-user/auth') {
          authSucceeded = true;
          settleTimer = setTimeout(() => finish(), 2000);
        }
      } catch { /* Ignore malformed third-party responses. */ }
    }
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    page.on('response', observe);
    void page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  });
}

async function authLogin(config) {
  await acquireAuthLock(config);
  await privateDirectory(config.profile);
  let context;
  try {
    const launcher = await chromium();
    context = await launcher.launchPersistentContext(config.profile, {
      headless: false,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    let page = context.pages().find(candidate => {
      try { return ['www.rappi.com.br', 'rappi.com.br'].includes(new URL(candidate.url()).hostname); }
      catch { return false; }
    }) ?? await context.newPage();
    if (!['www.rappi.com.br', 'rappi.com.br'].includes(new URL(page.url()).hostname)) {
      await page.goto(OFFICIAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.bringToFront();
    console.log('Complete login on the official Rappi page. The browser will close automatically after the API session is encrypted.');
    const controller = new AbortController();
    context.once('close', () => controller.abort(new Error('Login browser closed before an authenticated session was captured.')));
    const headers = await authenticatedHeaders(page, { signal: controller.signal });
    await saveSession(headers, { home: config.home, sessionFile: config.sessionFile });
    console.log('RAPPI_AUTH_READY Session encrypted with the OS credential store. API commands run browser-free.');
  } finally {
    if (context) await context.close().catch(() => {});
    await rm(config.authLock, { recursive: true, force: true });
  }
}

function help() {
  console.log(`Rappi API-first CLI\n\nUsage:\n  bun bin/rappi.mjs doctor\n  bun bin/rappi.mjs auth login|status|clear\n  bun bin/rappi.mjs search <query...> [--sort price|fastest|delivered] [--limit N] [--ean EAN] [--quantity N]\n  bun bin/rappi.mjs addresses list|set <id>\n  bun bin/rappi.mjs cart get\n  bun bin/rappi.mjs cart add --query Q --store-type TYPE --store-id ID --product-id ID [--units N]\n  bun bin/rappi.mjs cart remove --store-type TYPE --store-id ID --product-id ID\n  bun bin/rappi.mjs payments list --store-type TYPE --store-id ID\n  bun bin/rappi.mjs payments select --store-type TYPE --store-id ID --alias NAME\n  bun bin/rappi.mjs checkout preview --store-type TYPE\n  bun bin/rappi.mjs checkout approve --store-type TYPE\n  bun bin/rappi.mjs checkout cancel <approval-id>\n  bun bin/rappi.mjs order --store-type TYPE --approval-id ID\n  bun bin/rappi.mjs orders list`);
}

try {
  if (command === '--help' || command === '-h') {
    help();
  } else if (command === 'doctor') {
    if (process.argv.length !== 3) throw new Error('doctor does not accept arguments.');
    const diagnostic = await localDiagnostics();
    process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
    process.exitCode = diagnostic.readiness.local_setup_ready ? 0 : 1;
  } else if (command === 'auth' && process.argv.length === 4 && process.argv[3] === 'login') {
    await authLogin(configuration());
  } else {
    const { runApiCommand } = await import('../src/commands.mjs');
    const handled = await runApiCommand(command, process.argv.slice(3));
    if (handled === false) throw new Error(`Unknown command: ${command}. Use --help.`);
  }
} catch (error) {
  console.error(`Rappi CLI: ${error.message}`);
  process.exitCode = 1;
}
