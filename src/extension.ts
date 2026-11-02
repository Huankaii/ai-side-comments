import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Activity, AgentProgress, isExcluded, makePrompt, parseProgress, shortComment, summarizeEdits } from './core';
import { panelHtml } from './panel';

interface Note { uri: vscode.Uri; line: number; text: string; thread?: vscode.CommentThread }
interface Job { uri: vscode.Uri; line: number; version?: number; selection?: vscode.Range; userInitiated?: boolean; epoch: number }
const PREFIX = 'aiSideComments';
const BRIDGE = '.ai-side-comments/progress.json';

export class SideComments implements vscode.Disposable {
  private running = false;
  private automatic = false;
  private disposed = false;
  private epoch = 0;
  private model?: vscode.LanguageModelChat;
  private panel?: vscode.WebviewPanel;
  private entries: Activity[] = [];
  private notes = new Map<string, Note>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private jobs = new Map<string, Job>();
  private busy = false;
  private active?: { uri: string; cts: vscode.CancellationTokenSource };
  private seen = new Set<string>();
  private bridgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private bridgeReads = new Map<string, number>();
  private listeners: vscode.Disposable[] = [];
  private controller = vscode.comments.createCommentController(PREFIX, 'AI Side Comments');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('descriptionForeground'), fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });

  constructor(private readonly context: vscode.ExtensionContext) {
    const command = (name: string, callback: (...args: any[]) => unknown) => this.listeners.push(vscode.commands.registerCommand(`${PREFIX}.${name}`, callback));
    command('show', () => this.show());
    command('start', () => this.start());
    command('pause', () => this.pause());
    command('clear', () => this.clear());
    command('enableExplanations', () => this.enableExplanations());
    command('disableExplanations', () => this.disableExplanations());
    command('explain', () => this.explain());
    command('reportProgress', (p: unknown) => this.reportProgress(p));
    this.status.command = `${PREFIX}.show`;
    this.status.tooltip = 'AI Side Comments — show live progress and code explanations';
    this.status.show();
    this.listeners.push(vscode.workspace.onDidChangeTextDocument(e => this.changed(e)));
    this.listeners.push(vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const note of this.notes.values()) this.updateThread(note);
      this.decorate();
    }));
    this.listeners.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(PREFIX)) {
        for (const [key, note] of this.notes) {
          if (!this.allowed(note.uri)) { note.thread?.dispose(); this.notes.delete(key); }
          else this.updateThread(note);
        }
        this.decorate();
      }
    }));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.listeners.push(watcher,
      watcher.onDidChange(uri => this.diskChanged(uri, false)),
      watcher.onDidCreate(uri => this.diskChanged(uri, true)),
      watcher.onDidDelete(uri => this.deleted(uri)));
    const bridge = vscode.workspace.createFileSystemWatcher(`**/${BRIDGE}`);
    this.listeners.push(bridge, bridge.onDidChange(uri => this.queueBridge(uri)), bridge.onDidCreate(uri => this.queueBridge(uri)));
    this.refresh();
  }

  private config<T>(name: string, fallback: T): T { return vscode.workspace.getConfiguration(PREFIX).get<T>(name, fallback); }
  private allowed(uri: vscode.Uri): boolean {
    if (!vscode.workspace.isTrusted || uri.scheme !== 'file') return false;
    const root = vscode.workspace.getWorkspaceFolder(uri);
    if (!root) return false;
    const relative = uri.path.slice(root.uri.path.length + 1);
    return !isExcluded(relative, this.config<string[]>('excludedPaths', []));
  }

  show(): void {
    if (this.panel) { this.panel.reveal(undefined, true); this.refresh(); return; }
    const panel = vscode.window.createWebviewPanel(PREFIX, 'AI Side Comments', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel = panel;
    panel.webview.html = panelHtml(panel.webview, this.context.extensionUri);
    const message = panel.webview.onDidReceiveMessage(async data => {
      try {
        if (!data || typeof data !== 'object') return;
        switch (data.type) {
          case 'ready': this.refresh(); break;
          case 'start': await this.start(); break;
          case 'pause': this.pause(); break;
          case 'enable': await this.enableExplanations(); break;
          case 'disable': this.disableExplanations(); break;
          case 'explain': await this.explain(); break;
          case 'clear': this.clear(); break;
          case 'open': await this.openEntry(data.id); break;
        }
      } catch (error) { this.notifyError(error); }
    });
    panel.onDidDispose(() => { message.dispose(); this.panel = undefined; });
    this.refresh();
  }

  async start(): Promise<void> {
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showInformationMessage('Open a trusted workspace folder to watch code changes.'); return;
    }
    if (this.running) { this.show(); return; }
    this.epoch++;
    this.running = true;
    this.show();
    this.add({ source: 'system', title: 'Watching workspace edits', detail: 'Edits from you and coding assistants are labeled Observed. Agent-reported steps are labeled Agent progress.' });
    // Baseline existing progress files instead of replaying a previous session.
    await Promise.all(vscode.workspace.workspaceFolders.map(async root => {
      const uri = vscode.Uri.joinPath(root.uri, BRIDGE);
      await this.readBridge(uri, true);
    }));
    this.refresh();
  }

  pause(): void {
    this.running = false;
    this.cancelPending();
    this.add({ source: 'system', title: 'Watching paused', detail: 'Existing comments remain visible. Resume when your coding assistant starts its next task.' });
  }

  clear(): void {
    this.cancelPending();
    this.entries = [];
    for (const note of this.notes.values()) note.thread?.dispose();
    this.notes.clear();
    this.decorate();
    this.refresh();
  }

  private cancelPending(): void {
    this.epoch++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.bridgeTimers.values()) clearTimeout(timer);
    this.timers.clear(); this.bridgeTimers.clear(); this.jobs.clear();
    this.active?.cts.cancel();
    for (const entry of this.entries) if (entry.pending) { entry.pending = false; entry.detail = entry.detail ? `${entry.detail}\n\nStopped.` : 'Explanation stopped.'; }
  }

  private changed(event: vscode.TextDocumentChangeEvent): void {
    if (!event.contentChanges.length || !this.allowed(event.document.uri)) return;
    const key = event.document.uri.toString();
    // Invalidate old explanations as soon as code changes, including while paused.
    const previous = this.notes.get(key);
    if (previous) { previous.thread?.dispose(); this.notes.delete(key); this.decorate(); }
    if (this.active?.uri === key) this.active.cts.cancel();
    if (!this.running) return;
    const edit = summarizeEdits(event.contentChanges);
    this.add({ source: 'observed', title: edit.title, detail: vscode.workspace.asRelativePath(event.document.uri), uri: key, line: edit.line }, true);
    this.setNote(event.document.uri, edit.line, this.automatic ? 'Code changed — waiting for an explanation.' : 'Code changed — enable explanations in AI Side Comments.');
    if (this.automatic) this.schedule({ uri: event.document.uri, line: edit.line, version: event.document.version, epoch: this.epoch });
  }

  private diskChanged(uri: vscode.Uri, created: boolean): void {
    if (!this.allowed(uri)) return;
    // Open buffers already produce document-change events, including external edits.
    if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString())) return;
    const key = uri.toString();
    this.notes.get(key)?.thread?.dispose(); this.notes.delete(key); this.decorate();
    if (this.active?.uri === key) this.active.cts.cancel();
    if (!this.running) return;
    this.add({ source: 'observed', title: created ? 'Created file' : 'File changed on disk', detail: vscode.workspace.asRelativePath(uri), uri: uri.toString(), line: 0 }, true);
    if (this.automatic) this.schedule({ uri, line: 0, epoch: this.epoch });
  }

  private deleted(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.timers.get(key)); this.timers.delete(key); this.jobs.delete(key);
    if (this.active?.uri === key) this.active.cts.cancel();
    this.notes.get(key)?.thread?.dispose(); this.notes.delete(key); this.decorate();
    if (this.running && this.allowed(uri)) this.add({ source: 'observed', title: 'Deleted file', detail: vscode.workspace.asRelativePath(uri) });
  }

  private schedule(job: Job): void {
    const key = job.uri.toString();
    clearTimeout(this.timers.get(key));
    this.jobs.delete(key);
    // Bound pending work even when a generator touches thousands of files.
    if (this.timers.size >= 8 && !this.timers.has(key)) {
      const oldest = this.timers.keys().next().value as string;
      clearTimeout(this.timers.get(oldest)); this.timers.delete(oldest);
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.jobs.size >= 8) this.jobs.delete(this.jobs.keys().next().value!);
      this.jobs.set(key, job);
      void this.drain();
    }, this.config('explanationDelayMs', 2500)));
  }

  private async drain(): Promise<void> {
    if (this.busy || !this.automatic || !this.running) return;
    this.busy = true;
    try {
      while (this.jobs.size && this.running && this.automatic) {
        const [key, job] = this.jobs.entries().next().value!;
        this.jobs.delete(key);
        if (job.epoch === this.epoch) await this.generate(job);
      }
    } finally { this.busy = false; }
  }

  private async chooseModel(): Promise<boolean> {
    const models = await vscode.lm.selectChatModels();
    if (!models.length) {
      void vscode.window.showInformationMessage('No language models are available. Enable a model provider such as GitHub Copilot in VS Code, then try again. Edit progress works without a model.'); return false;
    }
    const chosen = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: model.vendor, model })), { title: 'Choose a model for code explanations', placeHolder: 'Code excerpts are sent to this model when explanations are enabled.' });
    if (!chosen) return false;
    this.model = chosen.model;
    this.refresh();
    return true;
  }

  async enableExplanations(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    if (!await this.chooseModel()) return;
    const model = this.model!;
    const cts = new vscode.CancellationTokenSource();
    const epoch = this.epoch;
    const timeout = setTimeout(() => cts.cancel(), 30000);
    try {
      // Initiate provider consent from this explicit command, before background work.
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('Reply with Ready. This enables short code explanations in AI Side Comments.')], { justification: 'Explain selected code and, while watching, recently edited code excerpts using your chosen model.' }, cts.token);
      for await (const _ of response.text) { if (cts.token.isCancellationRequested) break; }
      if (cts.token.isCancellationRequested || this.disposed || epoch !== this.epoch) return;
      this.automatic = true;
      this.add({ source: 'system', title: 'Code explanations enabled', detail: `Using ${model.name}. Recently edited code excerpts will be sent to this model while watching. Model provider usage limits apply.` });
      const editor = this.codeEditor();
      if (editor && this.running && this.allowed(editor.document.uri)) this.schedule({ uri: editor.document.uri, line: editor.selection.active.line, version: editor.document.version, epoch: this.epoch });
    } catch (error) { this.notifyError(error); }
    finally { clearTimeout(timeout); cts.dispose(); this.refresh(); }
  }

  disableExplanations(): void {
    this.automatic = false;
    this.cancelPending();
    this.add({ source: 'system', title: 'Automatic explanations disabled', detail: 'You can still explain code from the editor context menu.' });
  }

  private codeEditor(): vscode.TextEditor | undefined {
    return vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(e => this.allowed(e.document.uri));
  }

  async explain(): Promise<void> {
    const editor = this.codeEditor();
    if (!editor || !this.allowed(editor.document.uri)) {
      void vscode.window.showInformationMessage('Open a code file in a trusted workspace. Excluded files cannot be sent for explanation.'); return;
    }
    if (!this.model && !await this.chooseModel()) return;
    this.show();
    // Manual requests supersede automatic work and run immediately.
    this.cancelPending();
    await this.generate({ uri: editor.document.uri, line: editor.selection.start.line, selection: editor.selection.isEmpty ? undefined : editor.selection, version: editor.document.version, userInitiated: true, epoch: this.epoch });
  }

  private async generate(job: Job): Promise<void> {
    const model = this.model;
    if (!model || job.epoch !== this.epoch || !this.allowed(job.uri)) return;
    if (!job.userInitiated && this.context.languageModelAccessInformation.canSendRequest(model) !== true) {
      this.automatic = false;
      this.add({ source: 'system', title: 'Model access needs attention', detail: 'Use Enable Automatic Code Explanations to choose a model and grant access.' }); return;
    }
    const cts = new vscode.CancellationTokenSource();
    const active = { uri: job.uri.toString(), cts };
    this.active = active;
    const timeout = setTimeout(() => cts.cancel(), 45000);
    let entry: Activity | undefined;
    try {
      const stat = await vscode.workspace.fs.stat(job.uri);
      if (stat.size > this.config('maxFileBytes', 200000)) throw new Error('File is too large to explain. Select a smaller file or adjust maxFileBytes.');
      const doc = await vscode.workspace.openTextDocument(job.uri);
      if (Buffer.byteLength(doc.getText(), 'utf8') > this.config('maxFileBytes', 200000)) throw new Error('File is too large to explain.');
      if (job.version !== undefined && doc.version !== job.version) return;
      const version = doc.version;
      const line = Math.min(job.line, doc.lineCount - 1);
      const first = job.selection ? job.selection.start.line : Math.max(0, line - 12);
      const last = job.selection ? job.selection.end.line : Math.min(doc.lineCount - 1, line + 40);
      let excerpt = doc.getText(job.selection ?? new vscode.Range(first, 0, last, doc.lineAt(last).text.length)).slice(0, 12000);
      if (!excerpt.trim() || excerpt.includes('\0')) return;
      let prompt = makePrompt(vscode.workspace.asRelativePath(job.uri), doc.languageId, excerpt, first + 1, line + 1);
      // Leave a small margin for providers with a limited context window.
      while (await model.countTokens(prompt, cts.token) > model.maxInputTokens * 0.75) {
        if (excerpt.length < 200) throw new Error('The selected model has too little input capacity for this excerpt.');
        excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
        prompt = makePrompt(vscode.workspace.asRelativePath(job.uri), doc.languageId, excerpt, first + 1, line + 1);
      }
      const valid = () => !cts.token.isCancellationRequested && job.epoch === this.epoch && !this.disposed && doc.version === version;
      if (!valid()) return;
      entry = this.add({ source: 'explanation', title: `What this code does · ${vscode.workspace.asRelativePath(job.uri)}`, detail: '', uri: job.uri.toString(), line, pending: true });
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], { justification: 'Explain what this code does beside your editor.' }, cts.token);
      let text = '';
      let lastRefresh = 0;
      for await (const chunk of response.text) {
        if (!valid()) break;
        text = (text + chunk).slice(0, 6000);
        entry.detail = text;
        if (Date.now() - lastRefresh > 100) { this.refresh(); lastRefresh = Date.now(); }
        if (text.length >= 6000) break;
      }
      entry.pending = false;
      if (!valid()) { entry.detail = 'Explanation stopped because the code or session changed.'; return; }
      if (!text.trim()) throw new Error('The model returned no explanation. Try another model.');
      this.setNote(job.uri, line, text);
    } catch (error) {
      if (entry) { entry.pending = false; entry.detail = cts.token.isCancellationRequested ? 'Explanation stopped.' : `Could not explain code: ${error instanceof Error ? error.message : String(error)}`; }
      else if (!cts.token.isCancellationRequested && job.epoch === this.epoch) this.add({ source: 'system', title: 'Explanation unavailable', detail: error instanceof Error ? error.message : String(error) });
      // Pause retries on provider errors instead of hammering a blocked or offline model.
      if (!cts.token.isCancellationRequested) { this.automatic = false; this.jobs.clear(); }
    } finally {
      clearTimeout(timeout); cts.dispose();
      if (this.active === active) this.active = undefined;
      this.refresh();
    }
  }

  reportProgress(input: unknown, root?: vscode.WorkspaceFolder): boolean {
    if (!this.running || !vscode.workspace.isTrusted) return false;
    const p = parseProgress(input);
    root ??= vscode.workspace.workspaceFolders?.[0];
    const dedupe = `${root?.uri.toString() ?? ''}:${p.id}`;
    if (this.seen.has(dedupe)) return false;
    this.remember(dedupe);
    const uri = p.file && root ? vscode.Uri.joinPath(root.uri, p.file) : undefined;
    const permitted = uri && this.allowed(uri) ? uri : undefined;
    this.add({ source: 'agent', title: this.phaseTitle(p), detail: p.message, phase: p.phase, uri: permitted?.toString(), line: (p.line ?? 1) - 1 });
    if (permitted) this.setNote(permitted, (p.line ?? 1) - 1, p.message);
    return true;
  }

  private phaseTitle(p: AgentProgress): string {
    return ({ planning: 'Planning', editing: 'Editing code', testing: 'Running checks', done: 'Task completed', error: 'Agent reported an error' })[p.phase];
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
  }

  private queueBridge(uri: vscode.Uri): void {
    if (!this.running) return;
    const key = uri.toString();
    clearTimeout(this.bridgeTimers.get(key));
    this.bridgeTimers.set(key, setTimeout(() => { this.bridgeTimers.delete(key); void this.readBridge(uri, false); }, 150));
  }

  private async readBridge(uri: vscode.Uri, baseline: boolean): Promise<void> {
    const root = vscode.workspace.getWorkspaceFolder(uri);
    if (!root || uri.toString() !== vscode.Uri.joinPath(root.uri, BRIDGE).toString()) return;
    const epoch = this.epoch;
    const key = uri.toString();
    const read = (this.bridgeReads.get(key) ?? 0) + 1;
    this.bridgeReads.set(key, read);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 16000) return;
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > 16000 || epoch !== this.epoch || read !== this.bridgeReads.get(key) || !this.running) return;
      const p = parseProgress(JSON.parse(Buffer.from(bytes).toString('utf8')));
      if (baseline) this.remember(`${root.uri.toString()}:${p.id}`);
      else this.reportProgress(p, root);
    } catch { /* Missing or partially written progress files are ignored. Next save retries. */ }
  }

  private setNote(uri: vscode.Uri, line: number, text: string): void {
    const key = uri.toString();
    let note = this.notes.get(key);
    if (!note) {
      if (this.notes.size >= 80) { const oldest = this.notes.keys().next().value!; this.notes.get(oldest)?.thread?.dispose(); this.notes.delete(oldest); }
      note = { uri, line, text }; this.notes.set(key, note);
    }
    note.line = line; note.text = text;
    this.updateThread(note);
    this.decorate();
  }

  private updateThread(note: Note): void {
    const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === note.uri.toString());
    if (!document) return;
    note.line = Math.min(note.line, document.lineCount - 1);
    if (!this.config('showGutterComments', true)) { note.thread?.dispose(); note.thread = undefined; return; }
    const body = new vscode.MarkdownString();
    body.appendText(note.text);
    body.isTrusted = false;
    const comments = [{ body, mode: vscode.CommentMode.Preview, author: { name: 'AI Side Comments' } }];
    const range = new vscode.Range(note.line, 0, note.line, 0);
    if (note.thread) { note.thread.range = range; note.thread.comments = comments; }
    else {
      note.thread = this.controller.createCommentThread(note.uri, range, comments);
      note.thread.canReply = false;
      note.thread.label = 'Code progress & explanation';
      note.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }

  private decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const note = this.notes.get(editor.document.uri.toString());
      if (!note || !this.config('showInline', true)) { editor.setDecorations(this.decoration, []); continue; }
      const line = editor.document.lineAt(Math.min(note.line, editor.document.lineCount - 1));
      const hover = new vscode.MarkdownString(); hover.appendText(note.text); hover.isTrusted = false;
      editor.setDecorations(this.decoration, [{ range: new vscode.Range(line.range.end, line.range.end), hoverMessage: hover, renderOptions: { after: { contentText: `↳ ${shortComment(note.text)}` } } }]);
    }
  }

  private add(input: Omit<Activity, 'id' | 'time'>, coalesce = false): Activity {
    const previous = this.entries.at(-1);
    if (coalesce && previous?.source === 'observed' && previous.uri === input.uri && Date.now() - previous.time < 1500) {
      Object.assign(previous, input, { time: Date.now() }); this.refresh(); return previous;
    }
    const activity = { ...input, id: randomUUID(), time: Date.now() };
    this.entries.push(activity);
    if (this.entries.length > 120) this.entries.shift();
    this.refresh(); return activity;
  }

  private async openEntry(id: unknown): Promise<void> {
    const entry = this.entries.find(e => e.id === id);
    if (!entry?.uri) return;
    const uri = vscode.Uri.parse(entry.uri);
    if (!this.allowed(uri)) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.min(entry.line ?? 0, doc.lineCount - 1);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0) });
  }

  private refresh(): void {
    if (this.disposed) return;
    this.status.text = this.running ? '$(pulse) AI Comments' : '$(comment-discussion) AI Comments';
    void this.panel?.webview.postMessage({ type: 'state', running: this.running, automatic: this.automatic, model: this.model?.name, entries: this.entries });
  }

  private notifyError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.add({ source: 'system', title: 'Action could not complete', detail: message });
    void vscode.window.showErrorMessage(`AI Side Comments: ${message}`);
  }

  dispose(): void {
    this.disposed = true; this.cancelPending();
    this.panel?.dispose();
    for (const note of this.notes.values()) note.thread?.dispose();
    this.controller.dispose(); this.decoration.dispose(); this.status.dispose();
    for (const listener of this.listeners) listener.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const service = new SideComments(context);
  context.subscriptions.push(service);
  return { version: 1, reportProgress: (input: unknown) => service.reportProgress(input) };
}

export function deactivate(): void { /* ExtensionContext disposes all resources. */ }
