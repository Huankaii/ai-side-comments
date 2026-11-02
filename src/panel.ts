import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64');
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>AI Side Comments</title>
</head><body>
<header><div class="eyebrow"><span class="brand">↳</span> AI SIDE COMMENTS</div>
<div class="heading"><h1>Alongside your code.</h1><span id="status" class="status">Paused</span></div>
<p>Follow the work. Understand the code.</p></header>
<div class="toolbar"><button id="watch" class="primary">Start watching</button><button id="explain">Explain code</button><button id="clear" class="quiet" title="Clear comments and activity">Clear</button></div>
<section class="model"><div><strong>Code explanations</strong><span id="model-label">Choose a model to explain what changed.</span></div><button id="model">Enable</button></section>
<div class="section-title"><h2>LIVE ACTIVITY</h2><span id="count">0 updates</span></div>
<main id="feed" aria-label="Coding activity"></main>
<section id="empty"><div class="empty-icon">↳</div><h2>A little context, right here.</h2><p>Start watching, then ask your AI assistant to code. File activity appears here as it happens.</p><ol><li>Start watching your workspace.</li><li>Enable explanations with a VS Code model.</li><li>Click a file update to jump to the code.</li></ol></section>
<footer>Observed edits include human and AI changes. Agent progress needs the integration hook. Explanations describe code; private internal reasoning is unavailable.</footer>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}
