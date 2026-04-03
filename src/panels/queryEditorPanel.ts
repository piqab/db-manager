import * as vscode from 'vscode';
import { ConnectionManager } from '../connectionManager';

export class QueryEditorPanel {
  private static panels: Map<string, QueryEditorPanel> = new Map();

  static show(
    context: vscode.ExtensionContext,
    connMgr: ConnectionManager,
    connectionId: string,
    dbName: string
  ): void {
    const key = `query::${connectionId}::${dbName}`;
    const existing = QueryEditorPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbManagerQuery',
      `Query: ${dbName}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const instance = new QueryEditorPanel(panel, connMgr, connectionId, dbName);
    QueryEditorPanel.panels.set(key, instance);
    panel.onDidDispose(() => QueryEditorPanel.panels.delete(key));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly connMgr: ConnectionManager,
    private readonly connectionId: string,
    private readonly dbName: string
  ) {
    panel.webview.html = getHtml(dbName);

    panel.webview.onDidReceiveMessage(async (msg: { type: string; sql: string }) => {
      if (msg.type === 'runQuery') {
        await this.runQuery(msg.sql);
      }
    });
  }

  private async runQuery(sql: string): Promise<void> {
    const start = Date.now();
    try {
      const results = await this.connMgr.executeScript(this.connectionId, sql);
      const elapsed = Date.now() - start;
      const last = results[results.length - 1];
      this.panel.webview.postMessage({
        type: 'result',
        fields: last?.fields?.map(f => f.name) ?? [],
        rows: (last?.rows ?? []) as Record<string, unknown>[],
        rowCount: last?.rowCount ?? 0,
        statementsRun: results.length,
        elapsed,
        command: last?.command ?? '',
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({ type: 'error', message: error });
    }
  }
}

function getHtml(dbName: string): string {
  const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<title>SQL Query: ${dbName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  .toolbar-title { font-weight: bold; }
  .toolbar-spacer { flex: 1; }
  button { padding: 5px 14px; border: none; border-radius: 2px; cursor: pointer; font-size: 12px; }
  .btn-run { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: bold; }
  .btn-run:hover { background: var(--vscode-button-hoverBackground); }
  .btn-clear { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .editor-area { display: flex; flex-direction: column; flex: 0 0 220px; border-bottom: 3px solid var(--vscode-panel-border); }
  textarea { flex: 1; padding: 12px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); border: none; resize: none; font-family: var(--vscode-editor-font-family, 'Consolas, monospace'); font-size: 13px; line-height: 1.5; outline: none; }
  .result-area { flex: 1; overflow: auto; }
  .status-bar { padding: 4px 12px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); font-size: 11px; flex-shrink: 0; display: flex; gap: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead { position: sticky; top: 0; z-index: 5; }
  th { background: var(--vscode-editorGroupHeader-tabsBackground); padding: 5px 10px; text-align: left; font-weight: 600; border-right: 1px solid var(--vscode-panel-border); border-bottom: 2px solid var(--vscode-panel-border); white-space: nowrap; }
  td { padding: 4px 10px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; max-width: 400px; overflow: hidden; text-overflow: ellipsis; }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .error-msg { padding: 16px; color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); margin: 12px; border-radius: 2px; font-family: monospace; white-space: pre-wrap; }
  .hint { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
  .hint kbd { background: var(--vscode-keybindingLabel-background); padding: 2px 6px; border-radius: 2px; border: 1px solid var(--vscode-keybindingLabel-border, #555); font-size: 12px; }
</style>
</head>
<body>
<div class="toolbar">
  <span class="toolbar-title">⚡ SQL Query Editor — <em>${dbName}</em></span>
  <span class="toolbar-spacer"></span>
  <button class="btn-run" onclick="runQuery()">▶ Run (Ctrl+Enter)</button>
  <button class="btn-clear" onclick="clearAll()">Clear</button>
</div>

<div class="editor-area">
  <textarea id="sqlInput" placeholder="SELECT * FROM your_table LIMIT 100;&#10;&#10;-- Ctrl+Enter to execute&#10;-- Multiple statements separated by semicolons are supported"></textarea>
</div>

<div class="result-area" id="resultArea">
  <div class="hint">Write a SQL query above and press <kbd>Ctrl+Enter</kbd> or click <strong>Run</strong></div>
</div>

<div class="status-bar" id="statusBar"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'result') renderResult(msg);
    else if (msg.type === 'error') renderError(msg.message);
  });

  function runQuery() {
    const sql = document.getElementById('sqlInput').value.trim();
    if (!sql) return;
    document.getElementById('resultArea').innerHTML = '<div class="hint">Running...</div>';
    document.getElementById('statusBar').textContent = '';
    vscode.postMessage({ type: 'runQuery', sql });
  }

  function clearAll() {
    document.getElementById('sqlInput').value = '';
    document.getElementById('resultArea').innerHTML = '<div class="hint">Write a SQL query above and press <kbd>Ctrl+Enter</kbd> or click <strong>Run</strong></div>';
    document.getElementById('statusBar').textContent = '';
  }

  function renderResult(msg) {
    const area = document.getElementById('resultArea');
    if (!msg.fields || msg.fields.length === 0) {
      area.innerHTML = '<div class="hint">Query executed. ' + (msg.rowCount ?? 0) + ' rows affected.</div>';
    } else {
      const th = msg.fields.map(f => '<th>' + esc(f) + '</th>').join('');
      const tb = msg.rows.map(row =>
        '<tr>' + msg.fields.map(f =>
          '<td class="' + (row[f] === null || row[f] === undefined ? 'null' : '') + '">' +
          (row[f] === null || row[f] === undefined ? '<em>NULL</em>' : esc(String(row[f]))) +
          '</td>'
        ).join('') + '</tr>'
      ).join('');
      area.innerHTML = '<table><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table>';
    }
    const status = document.getElementById('statusBar');
    const parts = [
      msg.command ? 'Command: ' + msg.command : '',
      msg.rows ? msg.rows.length + ' rows returned' : '',
      msg.rowCount !== undefined ? msg.rowCount + ' rows affected' : '',
      msg.statementsRun + ' statement(s)',
      msg.elapsed + 'ms',
    ].filter(Boolean);
    status.textContent = parts.join('  |  ');
  }

  function renderError(message) {
    document.getElementById('resultArea').innerHTML = '<div class="error-msg">' + esc(message) + '</div>';
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  document.getElementById('sqlInput').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
    // Tab inserts spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart, end = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
  });
</script>
</body>
</html>`;
}
