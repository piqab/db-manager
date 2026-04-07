import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConnectionConfig, ConnectionManager, formatDbError } from '../connectionManager';

export class ConnectionPanel {
  static async show(
    context: vscode.ExtensionContext,
    connMgr: ConnectionManager,
    onSaved: () => void,
    existing?: ConnectionConfig
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'dbManagerConnection',
      existing ? `Edit: ${existing.name}` : 'New Connection',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getHtml(panel.webview, context.extensionUri, existing);

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'test': {
          try {
            await connMgr.testConnection(msg.config);
            panel.webview.postMessage({ type: 'testResult', success: true, message: 'Connection successful!' });
          } catch (err) {
            panel.webview.postMessage({ type: 'testResult', success: false, message: formatDbError(err) });
          }
          break;
        }
        case 'save': {
          const config: ConnectionConfig = {
            ...msg.config,
            id: existing?.id ?? crypto.randomUUID(),
          };
          try {
            await connMgr.saveConnection(config);
            panel.dispose();
            onSaved();
            vscode.window.showInformationMessage(`Connection "${config.name}" saved.`);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to save connection: ${error}`);
          }
          break;
        }
        case 'cancel':
          panel.dispose();
          break;
      }
    });
  }
}

interface WebviewMessage {
  type: 'test' | 'save' | 'cancel';
  config: ConnectionConfig;
}

function getHtml(
  webview: vscode.Webview,
  _extensionUri: vscode.Uri,
  existing?: ConnectionConfig
): string {
  const val = (v: unknown) => String(v ?? '').replace(/"/g, '&quot;');
  const c = existing;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>DB Connection</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
  h2 { margin-top: 0; color: var(--vscode-editor-foreground); }
  .form-group { margin-bottom: 14px; }
  label { display: block; margin-bottom: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  input, select { width: 100%; box-sizing: border-box; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 2px; font-size: 14px; }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  .row { display: grid; grid-template-columns: 1fr 120px; gap: 10px; }
  .actions { display: flex; gap: 8px; margin-top: 20px; }
  button { padding: 7px 16px; border: none; border-radius: 2px; cursor: pointer; font-size: 13px; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #555); }
  .result { margin-top: 12px; padding: 8px 12px; border-radius: 2px; font-size: 13px; display: none; }
  .result.success { background: var(--vscode-testing-iconPassed, #4caf50)22; color: var(--vscode-testing-iconPassed, #4caf50); border: 1px solid currentColor; }
  .result.error { background: var(--vscode-testing-iconFailed, #f44336)22; color: var(--vscode-errorForeground, #f44336); border: 1px solid currentColor; }
  .checkbox-group { display: flex; align-items: center; gap: 8px; }
  .checkbox-group input { width: auto; }
</style>
</head>
<body>
<h2>${c ? 'Edit Connection' : 'New PostgreSQL Connection'}</h2>
<div class="form-group">
  <label>Connection Name</label>
  <input id="name" type="text" value="${val(c?.name)}" placeholder="My Database" />
</div>
<div class="row">
  <div class="form-group">
    <label>Host</label>
    <input id="host" type="text" value="${val(c?.host ?? 'localhost')}" placeholder="localhost" />
  </div>
  <div class="form-group">
    <label>Port</label>
    <input id="port" type="number" value="${val(c?.port ?? 5432)}" placeholder="5432" />
  </div>
</div>
<div class="form-group">
  <label>Database</label>
  <input id="database" type="text" value="${val(c?.database)}" placeholder="postgres" />
</div>
<div class="form-group">
  <label>Username</label>
  <input id="user" type="text" value="${val(c?.user ?? 'postgres')}" placeholder="postgres" />
</div>
<div class="form-group">
  <label>Password</label>
  <input id="password" type="password" value="${val(c?.password)}" placeholder="••••••••" />
</div>
<div class="form-group">
  <label>SSL</label>
  <div class="checkbox-group">
    <input id="ssl" type="checkbox" ${c?.ssl ? 'checked' : ''} />
    <span>Enable SSL (rejectUnauthorized: false)</span>
  </div>
  <p style="margin:8px 0 0;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.4;">
    Облачные PostgreSQL (RDS, Neon, Supabase и т.д.) обычно требуют SSL. При ошибках TLS/SSL включите галочку.
  </p>
</div>
<div class="actions">
  <button class="btn-primary" onclick="save()">Save</button>
  <button class="btn-secondary" onclick="test()">Test Connection</button>
  <button class="btn-secondary" onclick="cancel()">Cancel</button>
</div>
<div id="result" class="result"></div>

<script>
  const vscode = acquireVsCodeApi();

  function getConfig() {
    return {
      name: document.getElementById('name').value.trim(),
      host: document.getElementById('host').value.trim(),
      port: parseInt(document.getElementById('port').value, 10) || 5432,
      database: document.getElementById('database').value.trim(),
      user: document.getElementById('user').value.trim(),
      password: document.getElementById('password').value,
      ssl: document.getElementById('ssl').checked,
    };
  }

  function showResult(success, message) {
    const el = document.getElementById('result');
    el.textContent = message;
    el.className = 'result ' + (success ? 'success' : 'error');
    el.style.display = 'block';
  }

  function test() {
    showResult(true, 'Testing connection...');
    document.getElementById('result').className = 'result';
    document.getElementById('result').style.display = 'block';
    vscode.postMessage({ type: 'test', config: getConfig() });
  }

  function save() {
    const config = getConfig();
    if (!config.name) { showResult(false, 'Connection name is required'); return; }
    if (!config.host) { showResult(false, 'Host is required'); return; }
    if (!config.database) { showResult(false, 'Database is required'); return; }
    vscode.postMessage({ type: 'save', config });
  }

  function cancel() {
    vscode.postMessage({ type: 'cancel' });
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'testResult') {
      showResult(msg.success, msg.message);
    }
  });
</script>
</body>
</html>`;
}
