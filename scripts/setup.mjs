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

async function requireCommand(command, args, message) {
  try {
    if (await run(command, args) === 0) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new Error(message);
}

try {
  if (!process.versions.bun) throw new Error('Run setup with Bun: bun run setup.');
  if (!['win32', 'darwin', 'linux'].includes(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}.`);
  }
  if (process.platform === 'darwin') {
    await requireCommand('/usr/bin/security', ['help'], 'The macOS Keychain security utility is required.');
  } else if (process.platform === 'linux') {
    await requireCommand('secret-tool', ['--help'], 'secret-tool is required. Install the libsecret command-line tools for your Linux distribution.');
  }

  const exitCode = await run(process.execPath, [
    path.join(root, 'node_modules/playwright/cli.js'), 'install', 'chromium',
  ], 'inherit');
  if (exitCode !== 0) throw new Error(`Chromium install exited ${exitCode}`);
  console.log('Ready. Run bun bin/rappi.mjs auth login, then complete login on the official Rappi page.');
} catch (error) {
  console.error(`Setup: ${error.message}`);
  process.exitCode = 1;
}
