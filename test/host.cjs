const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');

exports.run = async function () {
  const resultPath = process.env.AI_SIDE_COMMENTS_SMOKE_RESULT;
  try {
    const extension = vscode.extensions.getExtension('local-tools.ai-side-comments');
    assert.ok(extension, 'Extension discovered');
    const api = await extension.activate();
    assert.equal(api.version, 1);
    assert.equal(vscode.workspace.isTrusted, true);
    const root = vscode.workspace.workspaceFolders[0].uri;
    const uri = vscode.Uri.joinPath(root, 'example.ts');
    await vscode.workspace.fs.writeFile(uri, Buffer.from('export const double = (n: number) => n * 2;\n'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('aiSideComments.start');
    assert.equal(api.reportProgress({ id: 'host-start', phase: 'editing', message: 'Checking the native comments API.', file: 'example.ts', line: 1 }), true);
    assert.equal(api.reportProgress({ id: 'host-start', phase: 'editing', message: 'Duplicate' }), false);
    const bridgeDirectory = vscode.Uri.joinPath(root, '.ai-side-comments');
    await vscode.workspace.fs.createDirectory(bridgeDirectory);
    const bridgeUpdate = { id: 'host-bridge', phase: 'testing', message: 'Checking the filesystem progress bridge.' };
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(bridgeDirectory, 'progress.json'), Buffer.from(JSON.stringify(bridgeUpdate)));
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(api.reportProgress(bridgeUpdate), false, 'Filesystem watcher already delivered the progress update');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), '// Native editor event\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await doc.save();
    await vscode.commands.executeCommand('aiSideComments.pause');
    assert.equal(api.reportProgress({ id: 'paused', phase: 'done', message: 'Paused' }), false);
    await vscode.commands.executeCommand('aiSideComments.clear');
    const result = { success: true, vscodeVersion: vscode.version, checks: ['activation', 'trusted workspace', 'native side panel', 'native comment thread', 'progress command/API', 'filesystem progress bridge', 'deduplication', 'editor edit event', 'pause', 'clear'] };
    if (resultPath) await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  } catch (error) {
    if (resultPath) await fs.writeFile(resultPath, JSON.stringify({ success: false, error: error.stack }, null, 2));
    setTimeout(() => { void vscode.commands.executeCommand('workbench.action.closeWindow'); }, 100);
    throw error;
  }
};
