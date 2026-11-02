#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..');
  // Short profile paths avoid macOS Unix socket path limits in deep checkouts.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisc-'));
  // Keep watched files in the checkout: OS temporary directories can be excluded
  // by native filesystem watchers on some systems.
  const scratch = path.join(root, '.test-work');
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, 'fixture-'));
  const result = path.join(directory, 'result.json');
  const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'win32' ? 'code.cmd' : 'code');
  const args = ['--wait', '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(directory, 'profile')}`, `--extensions-dir=${path.join(directory, 'extensions')}`, `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(root, 'test', 'host.cjs')}`, fixture];
  const child = spawn(executable, args, { stdio: 'inherit', env: { ...process.env, AI_SIDE_COMMENTS_SMOKE_RESULT: result }, shell: process.platform === 'win32' });
  const timeout = setTimeout(() => { console.error('Native smoke test timed out after 90 seconds.'); child.kill(); process.exitCode = 1; }, 90000);
  child.on('error', error => { clearTimeout(timeout); console.error(`Could not launch VS Code: ${error.message}`); process.exitCode = 1; });
  child.on('close', async code => {
    clearTimeout(timeout);
    try {
      const outcome = JSON.parse(await fs.readFile(result, 'utf8'));
      console.log(JSON.stringify(outcome, null, 2));
      if (code !== 0 || !outcome.success) process.exitCode = 1;
    } catch { console.error('VS Code did not produce a smoke-test result.'); process.exitCode = 1; }
  });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
