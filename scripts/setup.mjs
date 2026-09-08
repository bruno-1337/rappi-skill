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

try {
  let runtime = process.execPath;
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
  } else if (process.versions.bun) {
    throw new Error('Run setup with an installed Node runtime on this platform.');
  }
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(runtime, [path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium'], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Chromium install exited ${exitCode}`);
  console.log('Ready. Run bun bin/rappi.mjs auth login, then complete login on the official Rappi page.');
} catch (error) {
  console.error(`Setup: ${error.message}`);
  process.exitCode = 1;
}
