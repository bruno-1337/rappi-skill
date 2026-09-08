import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '22.23.2';
const checksum = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function run(command, args, stdio = 'ignore') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

async function requireCommand(command, args, message) {
  try {
    if (await run(command, args) === 0) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new Error(message);
}

try {
  let runtime;
  if (process.platform === 'win32') {
    if (process.arch !== 'x64') throw new Error('Managed Windows runtime supports x64 only. Use an installed Node runtime on other architectures.');
    const directory = path.join(process.env.LOCALAPPDATA || homedir(), 'RappiConnector', 'runtime');
    runtime = path.join(directory, 'node.exe');
    let valid = false;
    try { valid = digest(await readFile(runtime)) === checksum; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!valid) {
      const response = await fetch(`https://nodejs.org/dist/v${version}/win-x64/node.exe`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (digest(bytes) !== checksum) throw new Error('Official Node SHA-256 mismatch; runtime was not installed.');
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, runtime); }
      finally { await rm(temporary, { force: true }); }
    }
  } else if (process.platform === 'darwin' || process.platform === 'linux') {
    runtime = 'node';
    await requireCommand(runtime, [
      '-e',
      "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)",
    ], 'Node.js 18 or newer is required on macOS and Linux.');
    if (process.platform === 'darwin') {
      await requireCommand('/usr/bin/security', ['help'], 'The macOS Keychain security utility is required.');
    } else {
      await requireCommand('secret-tool', ['--help'], 'secret-tool is required. Install the libsecret command-line tools for your Linux distribution.');
    }
  } else {
    throw new Error(`Unsupported platform: ${process.platform}.`);
  }

  const exitCode = await run(runtime, [path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], 'inherit');
  if (exitCode !== 0) throw new Error(`Chromium install exited ${exitCode}`);
  console.log('Ready. Run bun bin/rappi.mjs auth login, then complete login on the official Rappi page.');
} catch (error) {
  console.error(`Setup: ${error.message}`);
  process.exitCode = 1;
}
