import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, stdio = 'ignore') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

async function requireExecutable(command, args, message) {
  try {
    await run(command, args);
  } catch {
    throw new Error(message);
  }
}

try {
  if (!process.versions.bun) throw new Error('Run setup with Bun: bun run setup.');
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}.`);
  }
  const playwrightCli = path.join(root, 'node_modules/playwright/cli.js');
  try {
    await access(playwrightCli);
  } catch {
    throw new Error('Dependencies are missing. Run bun install before bun run setup.');
  }
  if (process.platform === 'darwin') {
    await requireExecutable('/usr/bin/security', ['help'], 'The macOS Keychain security utility is required.');
  } else if (process.platform === 'linux') {
    await requireExecutable('secret-tool', ['--help'], 'secret-tool is required. Install the libsecret command-line tools for your Linux distribution.');
  }

  const exitCode = await run(process.execPath, [playwrightCli, 'install', 'chromium'], 'inherit');
  if (exitCode !== 0) throw new Error(`Chromium install exited ${exitCode}`);
  console.log('Ready. Run bun bin/rappi.mjs auth login, then complete login on the official Rappi page.');
} catch (error) {
  console.error(`Setup: ${error.message}`);
  process.exitCode = 1;
}
