const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./mock-vscode.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const update = id => ({ id, phase: 'editing', message: 'Adding a doubling function.', file: 'src/main.ts', line: 2 });
const edit = f => f.callbacks.change({ document: f.document, contentChanges: [{ range: new f.vscode.Range(1, 0, 1, 4), rangeLength: 4, text: 'return n * 2;' }] });

test('watching is opt-in, progress deduplicates, and native comments anchor correctly', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  assert.equal(f.service.reportProgress(update('one')), false);
  await f.service.start();
  assert.equal(f.service.reportProgress(update('one')), true);
  assert.equal(f.service.reportProgress(update('one')), false);
  assert.equal(f.threads.at(-1).range.start.line, 1);
  assert.equal(f.threads.at(-1).canReply, false);
  f.service.pause(); assert.equal(f.service.reportProgress(update('two')), false);
});
test('untrusted workspaces block watching and model use', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  f.vscode.workspace.isTrusted = false;
  await f.service.start(); await f.service.explain(); await f.service.enableExplanations();
  assert.equal(f.service.running, false); assert.equal(f.requests.length, 0);
});
test('edits are labeled observed and never invoke a model before opt-in', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); edit(f); edit(f);
  assert.equal(f.service.entries.filter(e => e.source === 'observed').length, 1);
  assert.equal(f.requests.length, 0);
  assert.match(f.editor.decorations[0].renderOptions.after.contentText, /enable explanations/);
});
test('excluded files are never explained or observed', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); f.editor.document = f.doc('.env');
  await f.service.explain();
  assert.equal(f.requests.length, 0); assert.equal(f.service.notes.size, 0);
});
test('missing models leave edit progress available', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  f.vscode.lm.selectChatModels = async () => [];
  await f.service.start(); await f.service.enableExplanations(); edit(f);
  assert.equal(f.service.automatic, false); assert.equal(f.requests.length, 0);
  assert.ok(f.service.entries.some(e => e.source === 'observed'));
});
test('manual explanations stream into a side panel and a safe native comment', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.explain();
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].messages[0].content, /return n \* 2/);
  const entry = f.service.entries.find(e => e.source === 'explanation');
  assert.match(entry.detail, /doubles a number/); assert.equal(entry.pending, false);
  assert.equal(f.threads.at(-1).comments[0].body.isTrusted, false);
  assert.match(f.editor.decorations[0].renderOptions.after.contentText, /doubles/);
});
test('automatic explanations require a user command and debounce a burst of edits', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); await f.service.enableExplanations();
  assert.equal(f.requests.length, 1); // Consent handshake has no source code.
  assert.doesNotMatch(f.requests[0].messages[0].content, /return n/);
  edit(f); edit(f); edit(f);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.requests.length, 2);
  assert.equal(f.service.entries.filter(e => e.source === 'explanation').length, 1);
});
test('a changed document invalidates an in-flight explanation', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  let release;
  f.model.sendRequest = async () => ({ text: (async function* () { yield 'Old explanation'; await new Promise(resolve => { release = resolve; }); yield ' stale'; })() });
  const running = f.service.explain();
  while (!release) await tick();
  f.document.setText('function newer() {}'); edit(f); release(); await running;
  assert.equal(f.service.notes.size, 0);
  assert.match(f.service.entries.at(-1).detail, /stopped/);
});
test('pause cancels scheduled work and clear removes notes', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); await f.service.enableExplanations(); edit(f);
  f.service.pause(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.requests.length, 1);
  f.service.clear(); assert.equal(f.service.notes.size, 0); assert.equal(f.service.entries.length, 0);
  assert.equal(f.editor.decorations.length, 0);
});
test('revoked model access stops background requests without prompting', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start(); await f.service.enableExplanations();
  f.context.languageModelAccessInformation.canSendRequest = () => false;
  edit(f); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.requests.length, 1); assert.equal(f.service.automatic, false);
});
test('provider failure is surfaced and pauses automatic retries', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  f.service.model = f.model; f.service.automatic = true;
  f.model.sendRequest = async () => { throw new Error('Quota exceeded'); };
  await f.service.explain();
  assert.match(f.service.entries.at(-1).detail, /Quota exceeded/);
  assert.equal(f.service.automatic, false); assert.equal(f.service.notes.size, 0);
});
test('oversized files are not sent to the model', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  f.vscode.workspace.fs.stat = async () => ({ size: 9000000 });
  await f.service.explain(); assert.equal(f.requests.length, 0);
  assert.match(f.service.entries.at(-1).detail, /too large/);
});
test('bridge baselines old progress, handles malformed JSON and deduplicates events', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  let content = JSON.stringify(update('old'));
  f.vscode.workspace.fs.stat = async () => ({ size: content.length });
  f.vscode.workspace.fs.readFile = async () => Buffer.from(content);
  await f.service.start();
  assert.equal(f.service.entries.filter(e => e.source === 'agent').length, 0);
  const uri = f.vscode.Uri.file('/project/.ai-side-comments/progress.json');
  await f.service.readBridge(uri, false);
  assert.equal(f.service.entries.filter(e => e.source === 'agent').length, 0);
  content = '{'; await f.service.readBridge(uri, false);
  content = JSON.stringify(update('new')); await f.service.readBridge(uri, false); await f.service.readBridge(uri, false);
  assert.equal(f.service.entries.filter(e => e.source === 'agent').length, 1);
});
test('closed file events are visible and do not double-count open document edits', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  f.service.diskChanged(f.document.uri, false);
  assert.equal(f.service.entries.filter(e => e.source === 'observed').length, 0);
  f.service.diskChanged(f.vscode.Uri.file('/project/src/closed.ts'), true);
  assert.equal(f.service.entries.at(-1).title, 'Created file');
});
test('activity and annotations are bounded', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  for (let i = 0; i < 200; i++) f.service.reportProgress({ ...update(String(i)), file: `src/file${i}.ts` });
  assert.equal(f.service.entries.length, 120); assert.equal(f.service.notes.size, 80);
});
test('closed-file edits remove old notes even while watching is paused', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.service.start();
  f.service.reportProgress({ ...update('closed-note'), file: 'src/closed.ts' });
  f.service.pause();
  assert.equal(f.service.notes.size, 1);
  f.service.diskChanged(f.vscode.Uri.file('/project/src/closed.ts'), false);
  assert.equal(f.service.notes.size, 0);
});
test('a stream failure removes pending state and preserves a readable error', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  f.model.sendRequest = async () => ({ text: (async function* () { yield 'Partial explanation'; throw new Error('Connection lost'); })() });
  await f.service.explain();
  assert.equal(f.service.entries.at(-1).pending, false);
  assert.match(f.service.entries.at(-1).detail, /Connection lost/);
  assert.equal(f.service.notes.size, 0);
});
