const path = require('node:path');
const Module = require('node:module');

function fixture() {
  const callbacks = {};
  const commands = new Map();
  const sent = [];
  const threads = [];
  const requests = [];
  const errors = [];
  const options = { excludedPaths: ['**/node_modules/**', '**/dist/**'], explanationDelayMs: 5 };
  const disposable = () => ({ dispose() {} });
  const event = name => fn => { callbacks[name] = fn; return disposable(); };
  class Uri {
    constructor(value) { this.value = value; this.scheme = value.split(':')[0]; this.path = decodeURI(new URL(value).pathname); }
    toString() { return this.value; }
    static parse(value) { return new Uri(value); }
    static file(value) { return new Uri('file://' + value); }
    static joinPath(uri, ...parts) { return Uri.file(path.posix.join(uri.path, ...parts)); }
  }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      this.start = typeof a === 'number' ? new Position(a, b) : a;
      this.end = typeof a === 'number' ? new Position(c, d) : b;
    }
  }
  class MarkdownString { constructor() { this.value = ''; } appendText(text) { this.value += text; } }
  class CancellationTokenSource { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} }
  const root = { uri: Uri.file('/project'), name: 'project', index: 0 };
  const docs = new Map();
  function doc(file = 'src/main.ts', text = 'function double(n: number) {\n  return n * 2;\n}\n') {
    const uri = Uri.joinPath(root.uri, file);
    const document = {
      uri, languageId: 'typescript', version: 1,
      get lineCount() { return text.split('\n').length; },
      lineAt(n) { const line = text.split('\n')[n]; return { text: line, range: new Range(n, 0, n, line.length) }; },
      getText(range) { if (!range) return text; return text.split('\n').slice(range.start.line, range.end.line + 1).join('\n'); },
      setText(next) { text = next; this.version++; }
    };
    docs.set(uri.toString(), document);
    return document;
  }
  const document = doc();
  const editor = { document, selection: { start: new Position(0, 0), end: new Position(0, 0), active: new Position(0, 0), isEmpty: true }, setDecorations(type, decorations) { this.decorations = decorations; } };
  let responseText = ['This function doubles a number. ', 'It takes n and returns n multiplied by two.'];
  const model = {
    id: 'test-model', name: 'Test Model', vendor: 'test', maxInputTokens: 8000,
    countTokens: async prompt => Math.ceil(prompt.length / 4),
    async sendRequest(messages, opts, token) {
      requests.push({ messages, opts, token });
      const chunks = responseText;
      return { text: (async function* () { for (const chunk of chunks) { await new Promise(resolve => setImmediate(resolve)); yield chunk; } })() };
    }
  };
  const vscode = {
    Uri, Range, Position, MarkdownString, CancellationTokenSource,
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Right: 2 }, DecorationRangeBehavior: { ClosedClosed: 1 },
    ViewColumn: { One: 1, Beside: -2 }, CommentMode: { Preview: 0 }, CommentThreadCollapsibleState: { Collapsed: 0 },
    LanguageModelChatMessage: { User: content => ({ content }) },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return disposable(); } },
    comments: { createCommentController() { return { createCommentThread(uri, range, comments) { const thread = { uri, range, comments, dispose() { this.disposed = true; } }; threads.push(thread); return thread; }, ...disposable() }; } },
    window: {
      activeTextEditor: editor, visibleTextEditors: [editor],
      onDidChangeVisibleTextEditors: event('visible'),
      createStatusBarItem() { return { show() {}, ...disposable() }; },
      createTextEditorDecorationType: disposable,
      showInformationMessage: async message => { errors.push(message); },
      showErrorMessage: async message => { errors.push(message); },
      showQuickPick: async items => items[0],
      showTextDocument: async document => { editor.document = document; return editor; },
      createWebviewPanel() {
        const panel = { webview: { cspSource: 'mock:', asWebviewUri: uri => uri, postMessage: message => { sent.push(message); return Promise.resolve(true); }, onDidReceiveMessage: event('message') }, reveal() {}, onDidDispose: event('panelDispose'), dispose() { callbacks.panelDispose?.(); } };
        return panel;
      }
    },
    workspace: {
      isTrusted: true, workspaceFolders: [root], textDocuments: [document],
      getWorkspaceFolder: uri => uri.path.startsWith('/project/') ? root : undefined,
      getConfiguration: () => ({ get: (key, fallback) => options[key] ?? fallback }),
      asRelativePath: uri => uri.path.replace('/project/', ''),
      onDidChangeTextDocument: event('change'), onDidChangeConfiguration: event('config'),
      createFileSystemWatcher: () => ({ onDidChange: event('disk'), onDidCreate: event('create'), onDidDelete: event('delete'), ...disposable() }),
      fs: { stat: async uri => { if (!docs.has(uri.toString())) throw new Error('Not found'); return { size: 100 }; }, readFile: async () => Buffer.from('{}') },
      openTextDocument: async uri => { const found = docs.get(uri.toString()); if (!found) throw new Error('Not found'); return found; }
    },
    lm: { selectChatModels: async () => [model] }
  };
  const context = { extensionUri: Uri.file('/extension'), subscriptions: [], languageModelAccessInformation: { canSendRequest: () => true } };
  const original = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  let Extension;
  try {
    delete require.cache[require.resolve('../dist/extension')];
    delete require.cache[require.resolve('../dist/panel')];
    Extension = require('../dist/extension').SideComments;
  } finally { Module._load = original; }
  const service = new Extension(context);
  return { vscode, context, service, callbacks, commands, sent, threads, requests, errors, options, doc, document, editor, model, setResponse: text => { responseText = text; } };
}
module.exports = { fixture };
