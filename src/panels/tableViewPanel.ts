import * as vscode from 'vscode';
import { ConnectionManager, ColumnInfo } from '../connectionManager';
import { exportTable, importTable } from '../importExport';

interface TableViewState {
  connectionId: string;
  schema: string;
  table: string;
  page: number;
  pageSize: number;
  orderBy?: string;
  orderDir: 'ASC' | 'DESC';
  filter: string;
}

/** Messages from webview → extension */
type FromWebview =
  | { type: 'ready' }
  | { type: 'navigate'; page: number }
  | { type: 'sort'; column: string }
  | { type: 'filter'; filter: string }
  | { type: 'refresh' }
  | { type: 'changePageSize'; pageSize: number }
  | { type: 'updateRow'; row: Record<string, unknown>; updates: Record<string, unknown> }
  | { type: 'insertRow'; row: Record<string, unknown> }
  | { type: 'deleteRow'; row: Record<string, unknown> }
  | { type: 'panelExport' }
  | { type: 'panelImport' };

/** Messages extension → webview */
type ToWebview =
  | {
      type: 'init';
      schema: string;
      table: string;
      columns: ColumnInfo[];
      rows: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
      orderBy?: string;
      orderDir: 'ASC' | 'DESC';
      filter: string;
      hasPrimaryKey: boolean;
    }
  | {
      type: 'data';
      rows: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
      orderBy?: string;
      orderDir: 'ASC' | 'DESC';
    }
  | { type: 'error'; message: string }
  | { type: 'saved' }
  | { type: 'insertDone' };

export class TableViewPanel {
  private static panels: Map<string, TableViewPanel> = new Map();

  private readonly panel: vscode.WebviewPanel;
  private state: TableViewState;
  private columns: ColumnInfo[] = [];
  private initSent = false;

  static show(
    _context: vscode.ExtensionContext,
    connMgr: ConnectionManager,
    connectionId: string,
    schema: string,
    table: string
  ): void {
    const key = `${connectionId}::${schema}.${table}`;
    const existing = TableViewPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbManagerTable',
      `${schema}.${table}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const instance = new TableViewPanel(panel, connMgr, connectionId, schema, table);
    TableViewPanel.panels.set(key, instance);
    panel.onDidDispose(() => TableViewPanel.panels.delete(key));
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly connMgr: ConnectionManager,
    connectionId: string,
    schema: string,
    table: string
  ) {
    this.panel = panel;
    const pageSize = vscode.workspace.getConfiguration('dbManager').get<number>('pageSize', 100);
    this.state = { connectionId, schema, table, page: 0, pageSize, orderDir: 'ASC', filter: '' };

    panel.webview.html = getShellHtml(schema, table);

    panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
      await this.handleMessage(msg);
    });
  }

  private post(m: ToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  private async sendInitialData(): Promise<void> {
    try {
      this.columns = await this.connMgr.getColumns(
        this.state.connectionId,
        this.state.schema,
        this.state.table
      );
      const { rows, total } = await this.connMgr.getTableData(
        this.state.connectionId,
        this.state.schema,
        this.state.table,
        0,
        this.state.pageSize,
        this.state.orderBy,
        this.state.orderDir,
        this.state.filter || undefined
      );
      this.state.page = 0;
      const hasPrimaryKey = this.columns.some(c => c.is_primary);
      this.post({
        type: 'init',
        schema: this.state.schema,
        table: this.state.table,
        columns: this.columns,
        rows,
        total,
        page: this.state.page,
        pageSize: this.state.pageSize,
        orderBy: this.state.orderBy,
        orderDir: this.state.orderDir,
        filter: this.state.filter,
        hasPrimaryKey,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', message });
    }
  }

  private async fetchAndPost(): Promise<void> {
    try {
      const { rows, total } = await this.connMgr.getTableData(
        this.state.connectionId,
        this.state.schema,
        this.state.table,
        this.state.page * this.state.pageSize,
        this.state.pageSize,
        this.state.orderBy,
        this.state.orderDir,
        this.state.filter || undefined
      );
      this.post({
        type: 'data',
        rows,
        total,
        page: this.state.page,
        pageSize: this.state.pageSize,
        orderBy: this.state.orderBy,
        orderDir: this.state.orderDir,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', message });
    }
  }

  private async handleMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (!this.initSent) {
          this.initSent = true;
          await this.sendInitialData();
        }
        break;

      case 'navigate':
        this.state.page = msg.page;
        await this.fetchAndPost();
        break;

      case 'sort':
        if (this.state.orderBy === msg.column) {
          this.state.orderDir = this.state.orderDir === 'ASC' ? 'DESC' : 'ASC';
        } else {
          this.state.orderBy = msg.column;
          this.state.orderDir = 'ASC';
        }
        this.state.page = 0;
        await this.fetchAndPost();
        break;

      case 'filter':
        this.state.filter = msg.filter ?? '';
        this.state.page = 0;
        await this.fetchAndPost();
        break;

      case 'refresh':
        await this.fetchAndPost();
        break;

      case 'changePageSize':
        this.state.pageSize = msg.pageSize;
        this.state.page = 0;
        await this.fetchAndPost();
        break;

      case 'updateRow': {
        const pks = getPrimaryKeys(this.columns, msg.row);
        if (Object.keys(pks).length === 0) {
          this.post({ type: 'error', message: 'Cannot save: table has no primary key.' });
          return;
        }
        try {
          await this.connMgr.updateRow(
            this.state.connectionId,
            this.state.schema,
            this.state.table,
            pks,
            msg.updates
          );
          await this.fetchAndPost();
          this.post({ type: 'saved' });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.post({ type: 'error', message });
        }
        break;
      }

      case 'insertRow':
        try {
          await this.connMgr.insertRow(
            this.state.connectionId,
            this.state.schema,
            this.state.table,
            msg.row
          );
          this.state.page = 0;
          await this.fetchAndPost();
          this.post({ type: 'insertDone' });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.post({ type: 'error', message });
        }
        break;

      case 'deleteRow': {
        const pks = getPrimaryKeys(this.columns, msg.row);
        if (Object.keys(pks).length === 0) {
          this.post({ type: 'error', message: 'Cannot delete: no primary key.' });
          return;
        }
        try {
          await this.connMgr.deleteRow(
            this.state.connectionId,
            this.state.schema,
            this.state.table,
            pks
          );
          await this.fetchAndPost();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.post({ type: 'error', message });
        }
        break;
      }

      case 'panelExport':
        await exportTable(
          this.connMgr,
          this.state.connectionId,
          this.state.schema,
          this.state.table
        );
        break;

      case 'panelImport':
        await importTable(
          this.connMgr,
          this.state.connectionId,
          this.state.schema,
          this.state.table
        );
        await this.fetchAndPost();
        break;

      default:
        break;
    }
  }
}

function getPrimaryKeys(columns: ColumnInfo[], row: Record<string, unknown>): Record<string, unknown> {
  const pks: Record<string, unknown> = {};
  for (const col of columns) {
    if (col.is_primary) pks[col.name] = row[col.name];
  }
  return pks;
}

function getShellHtml(schema: string, table: string): string {
  const title = `${escapeHtml(schema)}.${escapeHtml(table)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; width: 100%; overflow: hidden; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      grid-template-columns: 1fr;
      min-height: 0;
    }
    .toolbar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .toolbar strong { font-weight: 600; }
    .spacer { flex: 1; min-width: 8px; }
    .filter-input {
      min-width: 200px; flex: 1; max-width: 420px;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 2px;
      font-size: 12px;
    }
    .filter-input:focus { outline: 1px solid var(--vscode-focusBorder); }
    button {
      padding: 4px 10px; border: none; border-radius: 2px; cursor: pointer;
      font-size: 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover { opacity: 0.9; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    select {
      padding: 3px 6px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, #555);
      border-radius: 2px;
      font-size: 12px;
    }
    #msgArea { min-height: 0; }
    .msg { padding: 6px 12px; font-size: 12px; border-left: 3px solid; }
    .msg.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    .msg.info { background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-inputValidation-infoForeground); border-color: var(--vscode-focusBorder); }

    #gridHost {
      min-height: 0;
      overflow: auto;
      border-top: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      position: relative;
    }
    #loadingOverlay {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: var(--vscode-editor-background);
      z-index: 2;
    }
    #loadingOverlay[hidden] { display: none !important; }

    table { width: max(100%, 640px); border-collapse: collapse; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      padding: 6px 10px; text-align: left; font-size: 12px; font-weight: 600;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 2px solid var(--vscode-panel-border);
      cursor: pointer; user-select: none; white-space: nowrap;
    }
    thead th:hover { background: var(--vscode-list-hoverBackground); }
    tbody td {
      padding: 4px 10px; font-size: 12px;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      max-width: 360px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      vertical-align: top;
    }
    tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
    tbody tr.selected td {
      background: var(--vscode-list-activeSelectionBackground) !important;
      color: var(--vscode-list-activeSelectionForeground);
    }
    td.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
    td.rn { width: 48px; text-align: right; color: var(--vscode-descriptionForeground); font-size: 11px; }
    td.act { width: 96px; white-space: nowrap; }
    .rb { font-size: 11px; padding: 2px 6px; margin-right: 4px; }
    .rb.del { background: transparent; color: var(--vscode-errorForeground, #f48771); }
    tbody tr.tr-draft td { white-space: normal; vertical-align: middle; }
    .draft-cell {
      width: 100%; min-width: 48px; max-width: 320px; box-sizing: border-box;
      padding: 3px 6px; font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .draft-cell:focus { outline: 1px solid var(--vscode-focusBorder); }
    textarea.draft-cell { min-height: 40px; resize: vertical; vertical-align: top; }

    .statusbar {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 12px;
      background: var(--vscode-statusBar-background);
      color: var(--vscode-statusBar-foreground);
      font-size: 12px;
    }
    .statusbar .info { flex: 1; }
    .pager { display: flex; align-items: center; gap: 4px; }
    .pager button { padding: 2px 8px; }
    .pager button:disabled { opacity: 0.45; cursor: default; }

    .empty {
      padding: 48px 16px; text-align: center; color: var(--vscode-descriptionForeground);
    }

    .overlay {
      position: fixed; inset: 0; z-index: 50;
      background: rgba(0,0,0,.55);
      display: none; align-items: center; justify-content: center;
    }
    .overlay.open { display: flex; }
    .modal {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 16px 20px;
      min-width: min(92vw, 560px);
      max-width: 720px;
      max-height: 85vh;
      overflow: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,.35);
    }
    .modal h3 { margin-bottom: 12px; font-size: 14px; }
    .fields { display: grid; grid-template-columns: minmax(120px, 160px) 1fr; gap: 8px 12px; align-items: start; }
    .fields label { font-size: 12px; color: var(--vscode-descriptionForeground); text-align: right; padding-top: 6px; }
    .fields input, .fields textarea {
      width: 100%;
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 2px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .fields textarea { min-height: 72px; resize: vertical; }
    .fields input[readonly], .fields textarea[readonly] { opacity: 0.65; cursor: not-allowed; }
    .modal-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }

    .row-ctx-menu {
      position: fixed;
      z-index: 60;
      min-width: 168px;
      padding: 4px 0;
      background: var(--vscode-menu-background, var(--vscode-editor-background));
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
    }
    .row-ctx-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 6px 14px;
      border: none;
      background: transparent;
      color: inherit;
      font-size: 13px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    .row-ctx-item:hover:not(:disabled) {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    }
    .row-ctx-item.danger:hover:not(:disabled) {
      color: var(--vscode-errorForeground, #f48771);
    }
    .row-ctx-item:disabled {
      opacity: 0.45;
      cursor: default;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span id="tbTitle">📋 <strong>${title}</strong></span>
    <input class="filter-input" id="fi" type="text" placeholder="WHERE clause (no WHERE keyword), e.g. id &gt; 5" autocomplete="off" />
    <button class="btn-primary" id="btnFilter" type="button">Filter</button>
    <button id="btnClearFilter" type="button">Clear</button>
    <span class="spacer"></span>
    <button class="btn-primary" id="btnInsert" type="button">+ Row</button>
    <button id="btnRefresh" type="button">↻ Refresh</button>
    <button id="btnExport" type="button" title="Export table (CSV / JSON / SQL)">Export</button>
    <button id="btnImport" type="button" title="Import from file">Import</button>
    <select id="ps" aria-label="Page size">
      <option value="50">50</option>
      <option value="100" selected>100</option>
      <option value="250">250</option>
      <option value="500">500</option>
      <option value="1000">1000</option>
    </select>
  </div>
  <div id="msgArea"></div>
  <div id="gridHost">
    <div id="loadingOverlay"><span id="loadingText">Loading…</span></div>
    <table id="dataTable" style="display:none">
      <thead><tr id="theadRow"></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="empty" id="emptyState" style="display:none">No rows</div>
  </div>
  <div class="statusbar">
    <span class="info" id="sinfo">Waiting for data…</span>
    <div class="pager">
      <button id="bFirst" type="button" title="First">«</button>
      <button id="bPrev" type="button" title="Previous">‹</button>
      <span id="pdisp">—</span>
      <button id="bNext" type="button" title="Next">›</button>
      <button id="bLast" type="button" title="Last">»</button>
    </div>
  </div>

  <div class="overlay" id="overlay" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle">
      <h3 id="mtitle">Edit</h3>
      <p class="hint" id="mhint"></p>
      <div class="fields" id="mfields"></div>
      <div class="modal-btns">
        <button class="btn-primary" id="msave" type="button">Save</button>
        <button id="mcancel" type="button">Cancel</button>
      </div>
    </div>
  </div>

  <script>
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any[]} */
  let COLS = [];
  let rows = [];
  let total = 0;
  let pg = 0;
  let pageSize = 100;
  let lastPg = 0;
  let orderBy = null;
  let orderDir = 'ASC';
  let filterStr = '';
  let modalMode = 'edit';
  /** @type {Record<string, unknown>|null} */
  let modalRow = null;
  let hasPK = true;
  let rowCtxMenuEl = null;
  let rowCtxCloseOnDoc = null;

  const el = (id) => document.getElementById(id);

  function hideRowContextMenu() {
    if (rowCtxMenuEl) {
      rowCtxMenuEl.remove();
      rowCtxMenuEl = null;
    }
    if (rowCtxCloseOnDoc) {
      document.removeEventListener('click', rowCtxCloseOnDoc, true);
      rowCtxCloseOnDoc = null;
    }
  }

  function showRowContextMenu(clientX, clientY, r) {
    hideRowContextMenu();
    const menu = document.createElement('div');
    menu.className = 'row-ctx-menu';
    menu.setAttribute('role', 'menu');

    function addItem(label, opts) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'row-ctx-item' + (opts.danger ? ' danger' : '');
      item.textContent = label;
      item.disabled = !!opts.disabled;
      item.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        hideRowContextMenu();
        if (!item.disabled && opts.onPick) opts.onPick();
      });
      menu.appendChild(item);
    }

    addItem('Edit', {
      disabled: !hasPK,
      onPick: function () { openEdit(r); },
    });
    addItem('Delete', {
      disabled: !hasPK,
      danger: true,
      onPick: function () {
        if (!confirm('Delete this row?')) return;
        vscode.postMessage({ type: 'deleteRow', row: r });
      },
    });

    document.body.appendChild(menu);
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let x = clientX;
    let y = clientY;
    if (x + w > window.innerWidth - 6) x = Math.max(6, window.innerWidth - w - 6);
    if (y + h > window.innerHeight - 6) y = Math.max(6, window.innerHeight - h - 6);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    rowCtxMenuEl = menu;

    rowCtxCloseOnDoc = function (ev) {
      if (menu.contains(ev.target)) return;
      hideRowContextMenu();
    };
    setTimeout(function () {
      document.addEventListener('click', rowCtxCloseOnDoc, true);
    }, 0);
  }

  function showMsg(text, kind) {
    const a = el('msgArea');
    if (!text) { a.innerHTML = ''; return; }
    const k = kind === 'error' ? 'error' : 'info';
    a.innerHTML = '<div class="msg ' + k + '">' + esc(text) + '</div>';
    if (kind !== 'error') setTimeout(function () { a.innerHTML = ''; }, 5000);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object' && v !== null && typeof v.toISOString === 'function') return v.toISOString();
    return String(v);
  }

  function renderHead() {
    const tr = el('theadRow');
    tr.innerHTML = '';
    const thNum = document.createElement('th');
    thNum.className = 'rn';
    thNum.textContent = '#';
    tr.appendChild(thNum);

    COLS.forEach(function (c) {
      const th = document.createElement('th');
      th.title = c.type + (c.is_primary ? ' · PK' : '');
      const arrow = orderBy === c.name
        ? (orderDir === 'ASC' ? ' ▲' : ' ▼')
        : ' ⇅';
      th.textContent = (c.is_primary ? '🔑 ' : '') + c.name + arrow;
      th.addEventListener('click', function () {
        vscode.postMessage({ type: 'sort', column: c.name });
      });
      tr.appendChild(th);
    });

    const thAct = document.createElement('th');
    thAct.textContent = 'Actions';
    thAct.style.cursor = 'default';
    tr.appendChild(thAct);
  }

  function renderDraftRow() {
    const tr = document.createElement('tr');
    tr.className = 'tr-draft';

    const tdN = document.createElement('td');
    tdN.className = 'rn';
    tdN.textContent = '—';
    tr.appendChild(tdN);

    COLS.forEach(function (c) {
      const td = document.createElement('td');
      let inp;
      if (fieldTag(c) === 'textarea') {
        inp = document.createElement('textarea');
        inp.rows = 2;
        inp.className = 'draft-cell';
      } else {
        inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'draft-cell';
      }
      inp.id = 'draft_' + c.name;
      inp.placeholder = c.nullable === 'YES' ? '(empty = NULL)' : '';
      inp.title = c.type + (c.is_primary ? ' · PK' : '');
      td.appendChild(inp);
      tr.appendChild(td);
    });

    const tdAct = document.createElement('td');
    tdAct.className = 'act';
    const bIns = document.createElement('button');
    bIns.className = 'rb btn-primary';
    bIns.type = 'button';
    bIns.textContent = 'Insert';
    bIns.title = 'Insert new row from this line';
    bIns.addEventListener('click', function (e) {
      e.stopPropagation();
      const row = {};
      COLS.forEach(function (c) {
        const node = document.getElementById('draft_' + c.name);
        const raw = node && 'value' in node ? node.value : '';
        row[c.name] = raw === '' ? null : raw;
      });
      vscode.postMessage({ type: 'insertRow', row: row });
    });
    tdAct.appendChild(bIns);
    tr.appendChild(tdAct);
    return tr;
  }

  function renderBody() {
    hideRowContextMenu();
    const tbody = el('tbody');
    const empty = el('emptyState');
    const tbl = el('dataTable');
    tbody.innerHTML = '';

    if (rows.length > 0) {
      empty.style.display = 'none';
      tbl.style.display = 'table';
      const off = pg * pageSize;

    rows.forEach(function (r, i) {
      const tr = document.createElement('tr');
      tr.addEventListener('click', function () {
        document.querySelectorAll('#tbody tr.selected').forEach(function (x) { x.classList.remove('selected'); });
        tr.classList.add('selected');
      });
      tr.addEventListener('dblclick', function (e) {
        if (e.target.closest('button')) return;
        openEdit(r);
      });
      tr.addEventListener('contextmenu', function (e) {
        if (e.target.closest('button')) return;
        e.preventDefault();
        document.querySelectorAll('#tbody tr.selected').forEach(function (x) { x.classList.remove('selected'); });
        tr.classList.add('selected');
        showRowContextMenu(e.clientX, e.clientY, r);
      });
      tr.title = 'Double-click to edit · Right-click for menu';

      const tdN = document.createElement('td');
      tdN.className = 'rn';
      tdN.textContent = String(off + i + 1);
      tr.appendChild(tdN);

      COLS.forEach(function (c) {
        const td = document.createElement('td');
        const v = r[c.name];
        const isNull = v === null || v === undefined;
        if (isNull) {
          td.className = 'null-val';
          td.innerHTML = '<em>NULL</em>';
        } else {
          td.textContent = cellText(v);
          td.title = cellText(v);
        }
        tr.appendChild(td);
      });

      const tdAct = document.createElement('td');
      tdAct.className = 'act';

      const bEdit = document.createElement('button');
      bEdit.className = 'rb';
      bEdit.type = 'button';
      bEdit.textContent = 'Edit';
      bEdit.disabled = !hasPK;
      bEdit.title = hasPK ? 'Edit row' : 'Primary key required';
      bEdit.addEventListener('click', function (e) {
        e.stopPropagation();
        openEdit(r);
      });

      const bDel = document.createElement('button');
      bDel.className = 'rb del';
      bDel.type = 'button';
      bDel.textContent = '✕';
      bDel.title = 'Delete';
      bDel.disabled = !hasPK;
      bDel.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!hasPK) return;
        if (!confirm('Delete this row?')) return;
        vscode.postMessage({ type: 'deleteRow', row: r });
      });

      tdAct.appendChild(bEdit);
      tdAct.appendChild(bDel);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });
      return;
    }

    if (total === 0) {
      empty.style.display = 'none';
      tbl.style.display = 'table';
      tbody.appendChild(renderDraftRow());
      return;
    }

    empty.textContent = 'No rows on this page (try another page or clear filter)';
    empty.style.display = 'block';
    tbl.style.display = 'none';
  }

  function renderStatus() {
    const sinfo = el('sinfo');
    if (total === 0) {
      sinfo.textContent = '0 rows · ' + COLS.length + ' columns';
    } else {
      const from = pg * pageSize + 1;
      const to = Math.min((pg + 1) * pageSize, total);
      sinfo.textContent = 'Rows ' + from + '–' + to + ' of ' + total.toLocaleString() + ' · page ' + (pg + 1) + '/' + (lastPg + 1);
    }
    el('pdisp').textContent = (pg + 1) + ' / ' + Math.max(1, lastPg + 1);
    el('bFirst').disabled = pg === 0;
    el('bPrev').disabled = pg === 0;
    el('bNext').disabled = pg >= lastPg;
    el('bLast').disabled = pg >= lastPg;
  }

  function setLoading(show, text) {
    const o = el('loadingOverlay');
    if (show) {
      o.hidden = false;
      el('loadingText').textContent = text || 'Loading…';
    } else {
      o.hidden = true;
    }
  }

  function applyInit(m) {
    COLS = m.columns || [];
    rows = m.rows || [];
    total = m.total || 0;
    pg = m.page || 0;
    pageSize = m.pageSize || 100;
    orderBy = m.orderBy || null;
    orderDir = m.orderDir || 'ASC';
    filterStr = m.filter || '';
    hasPK = !!m.hasPrimaryKey;

    el('fi').value = filterStr;
    el('ps').value = String(pageSize);

    lastPg = Math.max(0, Math.ceil(total / pageSize) - 1);
    el('tbTitle').innerHTML = '📋 <strong>' + esc(m.schema) + '.' + esc(m.table) + '</strong>';

    el('emptyState').textContent = 'No rows';
    renderHead();
    renderBody();
    renderStatus();
    setLoading(false, '');
  }

  function applyData(m) {
    rows = m.rows || [];
    total = m.total || 0;
    pg = m.page || 0;
    pageSize = m.pageSize || pageSize;
    if (m.orderBy !== undefined) orderBy = m.orderBy;
    if (m.orderDir) orderDir = m.orderDir;
    lastPg = Math.max(0, Math.ceil(total / pageSize) - 1);
    renderHead();
    renderBody();
    renderStatus();
  }

  window.addEventListener('message', function (e) {
    const m = e.data;
    if (!m || !m.type) return;
    if (m.type === 'init') {
      applyInit(m);
      return;
    }
    if (m.type === 'data') {
      applyData(m);
      showMsg('', '');
      return;
    }
    if (m.type === 'error') {
      setLoading(false, '');
      showMsg(m.message, 'error');
      return;
    }
    if (m.type === 'saved') {
      closeModal();
      showMsg('Saved', 'info');
      return;
    }
    if (m.type === 'insertDone') {
      closeModal();
      showMsg('Row inserted', 'info');
      return;
    }
  });

  function nav(p) {
    if (p < 0 || p > lastPg) return;
    vscode.postMessage({ type: 'navigate', page: p });
  }

  el('bFirst').addEventListener('click', function () { nav(0); });
  el('bPrev').addEventListener('click', function () { nav(pg - 1); });
  el('bNext').addEventListener('click', function () { nav(pg + 1); });
  el('bLast').addEventListener('click', function () { nav(lastPg); });

  el('btnFilter').addEventListener('click', function () {
    vscode.postMessage({ type: 'filter', filter: el('fi').value.trim() });
  });
  el('btnClearFilter').addEventListener('click', function () {
    el('fi').value = '';
    vscode.postMessage({ type: 'filter', filter: '' });
  });
  el('fi').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') el('btnFilter').click();
  });

  el('btnRefresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });
  el('btnExport').addEventListener('click', function () {
    vscode.postMessage({ type: 'panelExport' });
  });
  el('btnImport').addEventListener('click', function () {
    vscode.postMessage({ type: 'panelImport' });
  });
  el('ps').addEventListener('change', function () {
    const v = parseInt(el('ps').value, 10);
    vscode.postMessage({ type: 'changePageSize', pageSize: v });
  });

  el('btnInsert').addEventListener('click', function () {
    openInsert();
  });

  function fieldTag(c) {
    const t = (c.type || '').toLowerCase();
    if (t === 'text' || t === 'json' || t === 'jsonb' || t === 'bytea' || t.indexOf('json') >= 0) return 'textarea';
    return 'input';
  }

  function openEdit(row) {
    modalMode = 'edit';
    modalRow = row;
    el('mtitle').textContent = 'Edit row';
    el('mhint').textContent = hasPK
      ? 'Change fields and click Save. Primary key columns are read-only.'
      : 'This table has no primary key — updates from the UI are disabled.';
    el('mfields').innerHTML = '';
    COLS.forEach(function (c) {
      const lab = document.createElement('label');
      lab.htmlFor = 'f_' + c.name;
      lab.textContent = c.name;
      const sub = document.createElement('div');
      sub.style.fontSize = '10px';
      sub.style.opacity = '0.7';
      sub.textContent = c.type;
      lab.appendChild(document.createElement('br'));
      lab.appendChild(sub);

      const ro = c.is_primary && modalMode === 'edit';
      const val = row && row[c.name] !== undefined && row[c.name] !== null ? cellText(row[c.name]) : '';
      let input;
      if (fieldTag(c) === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 4;
      } else {
        input = document.createElement('input');
        input.type = 'text';
      }
      input.id = 'f_' + c.name;
      input.value = val;
      if (ro) input.readOnly = true;

      el('mfields').appendChild(lab);
      el('mfields').appendChild(input);
    });
    el('msave').style.display = hasPK ? 'inline-block' : 'none';
    el('overlay').classList.add('open');
    el('overlay').setAttribute('aria-hidden', 'false');
  }

  function openInsert() {
    modalMode = 'insert';
    modalRow = null;
    el('mtitle').textContent = 'New row';
    el('mhint').textContent = 'Fill in fields. Empty values become NULL for nullable columns.';
    el('mfields').innerHTML = '';
    COLS.forEach(function (c) {
      const lab = document.createElement('label');
      lab.htmlFor = 'f_' + c.name;
      lab.textContent = c.name;
      const sub = document.createElement('div');
      sub.style.fontSize = '10px';
      sub.style.opacity = '0.7';
      sub.textContent = c.type + (c.nullable === 'YES' ? ' · NULL OK' : '');
      lab.appendChild(document.createElement('br'));
      lab.appendChild(sub);

      let input;
      if (fieldTag(c) === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
      } else {
        input = document.createElement('input');
        input.type = 'text';
      }
      input.id = 'f_' + c.name;
      input.placeholder = c.nullable === 'YES' ? '(empty = NULL)' : '';

      el('mfields').appendChild(lab);
      el('mfields').appendChild(input);
    });
    el('msave').style.display = 'inline-block';
    el('overlay').classList.add('open');
    el('overlay').setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    el('overlay').classList.remove('open');
    el('overlay').setAttribute('aria-hidden', 'true');
  }

  el('mcancel').addEventListener('click', closeModal);
  el('overlay').addEventListener('click', function (e) {
    if (e.target === el('overlay')) closeModal();
  });

  el('msave').addEventListener('click', function () {
    if (modalMode === 'edit') {
      if (!hasPK || !modalRow) return;
      const upd = {};
      COLS.filter(function (c) { return !c.is_primary; }).forEach(function (c) {
        const node = el('f_' + c.name);
        const raw = node && 'value' in node ? node.value : '';
        upd[c.name] = raw === '' ? null : raw;
      });
      vscode.postMessage({ type: 'updateRow', row: modalRow, updates: upd });
    } else {
      const row = {};
      COLS.forEach(function (c) {
        const node = el('f_' + c.name);
        const raw = node && 'value' in node ? node.value : '';
        row[c.name] = raw === '' ? null : raw;
      });
      vscode.postMessage({ type: 'insertRow', row: row });
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideRowContextMenu();
      closeModal();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && el('overlay').classList.contains('open')) {
      el('msave').click();
    }
  });

  window.addEventListener('load', function () {
    vscode.postMessage({ type: 'ready' });
  });
})();
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
