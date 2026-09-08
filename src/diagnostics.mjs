import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { sessionConfiguration } from './session.mjs';

async function filePresence(file) {
  try {
    return (await stat(file)).isFile() ? 'present' : 'unavailable';
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable';
  }
}

export async function localDiagnostics() {
  const bun = globalThis.Bun;
  const runtimeSupported = Boolean(process.versions.bun && bun);
  const platformSupported = ['win32', 'darwin', 'linux'].includes(process.platform);
  const nextSteps = [];
  if (!runtimeSupported) nextSteps.push('Run this command with Bun: bun bin/rappi.mjs doctor.');
  if (!platformSupported) nextSteps.push('Use Windows, macOS, or Linux for encrypted local storage.');

  let playwright = 'available';
  let chromiumExecutable = 'not_checked';
  try {
    createRequire(import.meta.url).resolve('playwright');
  } catch (error) {
    playwright = error.code === 'MODULE_NOT_FOUND' ? 'missing' : 'unavailable';
  }
  if (playwright === 'available') {
    try {
      const { chromium } = await import('playwright');
      chromiumExecutable = await filePresence(chromium.executablePath());
    } catch {
      playwright = 'unavailable';
    }
  }
  if (playwright !== 'available') {
    nextSteps.push('Run bun install, then bun run setup to install Playwright and Chromium.');
  } else if (chromiumExecutable !== 'present') {
    nextSteps.push('Run bun run setup to install Chromium; if it remains unavailable, check local browser-cache permissions.');
  }

  const helper = process.platform === 'win32' ? 'powershell.exe'
    : process.platform === 'darwin' ? '/usr/bin/security'
      : process.platform === 'linux' ? 'secret-tool' : null;
  let helperExecutable = 'not_checked';
  if (runtimeSupported && helper) {
    try {
      // Locate only: help exit codes and credential-store state are irrelevant here.
      helperExecutable = bun.which(helper) ? 'available' : 'missing';
    } catch {
      helperExecutable = 'not_checked';
    }
    if (helperExecutable !== 'available') {
      nextSteps.push(process.platform === 'linux'
        ? 'Install the libsecret command-line tools for your Linux distribution and make secret-tool available on PATH.'
        : process.platform === 'darwin'
          ? 'Restore the macOS Keychain security utility at /usr/bin/security.'
          : 'Make Windows PowerShell (powershell.exe) available on PATH.');
    }
  }

  // Metadata only: do not open, decrypt, or infer authentication from this file.
  const sessionFile = await filePresence(sessionConfiguration().sessionFile);
  const localSetupReady = runtimeSupported && platformSupported && playwright === 'available'
    && chromiumExecutable === 'present' && helperExecutable === 'available';
  if (sessionFile === 'unavailable') {
    nextSteps.push('Check access permissions for the configured connector state directory.');
  } else if (sessionFile === 'missing') {
    nextSteps.push('After local setup is ready, run bun bin/rappi.mjs auth login to create an encrypted session.');
  } else {
    nextSteps.push('A saved session file is present, but authentication was not checked. Request an authenticated command only when needed; log in again if it reports an expired session.');
  }
  nextSteps.push('Credential-store backend accessibility and Chromium launch capability remain unchecked; auth login exercises them when explicitly requested.');

  return {
    runtime: { name: runtimeSupported ? 'bun' : 'node', version: process.versions.bun ?? process.version, supported: runtimeSupported },
    platform: { name: process.platform, arch: process.arch, supported: platformSupported },
    dependencies: { playwright },
    chromium: { executable: chromiumExecutable, launch: 'not_checked' },
    credential_helper: { name: helper, executable: helperExecutable, backend: 'unknown' },
    session: { file: sessionFile, authentication: 'not_checked' },
    readiness: { local_setup_ready: localSetupReady, remote_access: 'not_checked' },
    next_steps: nextSteps,
  };
}
