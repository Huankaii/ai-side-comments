(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let state = { running: false, automatic: false, entries: [] };
  let lastShape = '';
  const send = type => vscode.postMessage({ type });
  $('watch').addEventListener('click', () => send(state.running ? 'pause' : 'start'));
  $('explain').addEventListener('click', () => send('explain'));
  $('clear').addEventListener('click', () => send('clear'));
  $('model').addEventListener('click', () => send(state.automatic ? 'disable' : 'enable'));
  const labels = { observed: 'Observed edit', agent: 'Agent progress', explanation: 'Code explained', system: 'Session' };

  function card(entry) {
    const article = document.createElement('article');
    article.className = 'entry ' + entry.source;
    article.dataset.id = entry.id;
    const meta = document.createElement('div'); meta.className = 'meta';
    const label = document.createElement('span'); label.className = 'badge';
    label.textContent = labels[entry.source] || 'Update';
    const time = document.createElement('time'); time.dateTime = new Date(entry.time).toISOString();
    time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.append(label, time);
    const title = document.createElement(entry.uri ? 'button' : 'h3');
    title.className = 'entry-title'; title.textContent = entry.title;
    if (entry.uri) {
      title.title = 'Jump to code';
      title.addEventListener('click', () => vscode.postMessage({ type: 'open', id: entry.id }));
    }
    const detail = document.createElement('p'); detail.className = 'detail';
    detail.textContent = entry.detail || (entry.pending ? 'Reading the changed code…' : '');
    const progress = document.createElement('span'); progress.className = 'streaming'; progress.textContent = 'Explaining…'; progress.hidden = !entry.pending;
    article.append(meta, title, detail, progress);
    if (entry.phase === 'error') article.classList.add('error');
    if (entry.phase === 'done') article.classList.add('done');
    return article;
  }

  window.addEventListener('message', event => {
    if (event.data?.type !== 'state') return;
    state = event.data;
    $('status').textContent = state.running ? 'Live' : 'Paused';
    $('status').classList.toggle('live', state.running);
    $('watch').textContent = state.running ? 'Pause watching' : 'Start watching';
    $('model').textContent = state.automatic ? 'Disable' : 'Enable';
    $('model-label').textContent = state.automatic ? state.model + ' · explains edits automatically' : state.model ? state.model + ' · automatic explanations off' : 'Choose a model to explain what changed.';
    $('count').textContent = state.entries.length + (state.entries.length === 1 ? ' update' : ' updates');
    $('empty').hidden = state.entries.length > 0;
    const shape = JSON.stringify(state.entries);
    if (shape !== lastShape) {
      const feed = $('feed');
      const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
      feed.replaceChildren(...state.entries.map(card));
      if (nearBottom) window.scrollTo({ top: document.body.scrollHeight });
      lastShape = shape;
    }
  });
  send('ready');
})();
