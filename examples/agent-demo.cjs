#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const delay = () => new Promise(resolve => setTimeout(resolve, 600));

(async () => {
  if (!process.argv[2]) throw new Error('Usage: node examples/agent-demo.cjs /path/to/test-workspace');
  const root = path.resolve(process.argv[2]);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('The workspace must be an existing directory.');
  const file = 'ai-side-comments-demo.cjs';
  const target = path.join(root, file);
  const directory = path.join(root, '.ai-side-comments');
  await fs.mkdir(directory, { recursive: true });
  async function report(phase, message, anchor = false) {
    const id = randomUUID();
    const update = { id, phase, message, ...(anchor ? { file, line: 5 } : {}) };
    const temporary = path.join(directory, `${id}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(update, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, path.join(directory, 'progress.json'));
    console.log(`${phase}: ${message}`);
    await delay();
  }
  await report('planning', 'I will clean a list of names by trimming whitespace, removing blanks, and dropping duplicates.');
  const source = [
    '/** Clean a list of names without changing the input array. */',
    'function cleanNames(names) {',
    '  const trimmed = names.map(name => name.trim());',
    '  const nonEmpty = trimmed.filter(Boolean);',
    '  return [...new Set(nonEmpty)];',
    '}',
    '',
    'module.exports = { cleanNames };',
    ''
  ].join('\n');
  await fs.writeFile(target, source, { flag: 'wx' });
  await report('editing', 'map trims each name, filter removes empty strings, and Set keeps each remaining name once. The function returns a new array.', true);
  await report('testing', 'Checking normalization, empty input, and preservation of the original array.');
  const { cleanNames } = require(target);
  const input = [' Ada ', '', 'Ada', ' Lin '];
  assert.deepEqual(cleanNames(input), ['Ada', 'Lin']);
  assert.deepEqual(cleanNames([]), []);
  assert.deepEqual(input, [' Ada ', '', 'Ada', ' Lin ']);
  await report('done', 'All three sample checks passed. Whitespace and duplicates are removed, and the original array stays unchanged.');
  console.log(`Sample code: ${target}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
