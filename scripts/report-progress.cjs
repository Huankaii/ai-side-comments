#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseProgress } = require('../dist/core');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || process.argv[i + 1] === undefined) {
    console.error('Usage: node report-progress.cjs --root PROJECT --phase editing --message "Updating code" [--file src/main.ts --line 12]');
    process.exit(1);
  }
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
let temporary;
try {
  if (!args.root) throw new Error('--root is required.');
  const progress = parseProgress({ id: randomUUID(), phase: args.phase, message: args.message, ...(args.file ? { file: args.file } : {}), ...(args.line ? { line: Number(args.line) } : {}) });
  const directory = path.join(path.resolve(args.root), '.ai-side-comments');
  fs.mkdirSync(directory, { recursive: true });
  temporary = path.join(directory, `progress-${progress.id}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(progress, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temporary, path.join(directory, 'progress.json'));
  console.log(`Reported ${progress.phase}: ${progress.message}`);
} catch (error) {
  if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
  console.error(error.message); process.exitCode = 1;
}
