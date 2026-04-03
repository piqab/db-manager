import * as vscode from 'vscode';
import { ConnectionManager, ColumnInfo } from '../connectionManager';

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

export class TableViewPanel {
  private static panels: Map<string, TableViewPanel> = new Map();

  private readonly panel: vscode.WebviewPanel;
  private state: TableViewState;
  private columns: ColumnInfo[] = [];

  static show(
    context: vscode.ExtensionContext,
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
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );

    const instance = new TableViewPanel(panel, connMgr, connectionId, schema, table, context);
    TableViewPanel.panels.set(key, instance);

    panel.onDidDispose(() => {
      TableViewPanel.panels.delete(key);
    });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly connMgr: ConnectionManager,
    connectionId: string,
    schema: string,
    table: string,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel = panel;
    const pageSize = vscode.workspace.getConfiguration('dbManager').get<number>('pageSize', 100);
    this.state = { connectionId, schema, table, page: 0, pageSize, orderDir: 'ASC', filter: '' };

    panel.webview.html = getLoadingHtml();
    this.loadAndRender();

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this.handleMessage(msg);
    });
  }

  private async loadAndRender(): Promise<void> {
    try {
      this.columns = await this.connMgr.getColumns(
        this.state.connectionId,
        this.state.schema,
        this.state.table
      );
      this.panel.webview.html = getTableHtml(this.panel.webview, this.context.extensionUri, this.state, this.columns);
      await this.fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.html = getErrorHtml(msg);
    }
  }

  private async fetchData(): Promise<void> {
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
      this.panel.webview.postMessage({
        type: 'data',
        rows,
        total,
        page: this.state.page,
        pageSize: this.state.pageSize,
        columns: this.columns,
        orderBy: this.state.orderBy,
        orderDir: this.state.orderDir,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({ type: 'error', message: msg });
    }
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'navigate':
        this.state.page = msg.page!;
        await this.fetchData();
        break;

      case 'sort':
        if (this.state.orderBy === msg.column) {
          this.state.orderDir = this.state.orderDir === 'ASC' ? 'DESC' : 'ASC';
        } else {
          this.state.orderBy = msg.column;
          this.state.orderDir = 'ASC';
        }
        this.state.page = 0;
        await this.fetchData();
        break;

      case 'filter':
        this.state.filter = msg.filter ?? '';
        this.state.page = 0;
        await this.fetchData();
        break;

      case 'updateRow': {
        const pks = getPrimaryKeys(this.columns, msg.row!);
        if (Object.keys(pks).length === 0) {
          this.panel.webview.postMessage({ type: 'error', message: 'Cannot update: no primary key found' });
          return;
        }
        try {
          await this.connMgr.updateRow(
            this.state.connectionId,
            this.state.schema,
            this.state.table,
            pks,
            msg.updates!
          );
          this.panel.webview.postMessage({ type: 'updateSuccess' });
          await this.fetchData();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.panel.webview.postMessage({ type: 'error', message: error });
        }
        break;
      }

      case 'insertRow': {
        try {
          await this.connMgr.insertRow(
            this.state.connectionId,
            this.state.schema,
            this.state.table,
            msg.row!
          );
          this.panel.webview.postMessage({ type: 'insertSuccess' });
          await this.fetchData();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.panel.webview.postMessage({ type: 'error', message: error });
        }
        break;
      }

      case 'deleteRow': {
        const pks = getPrimaryKeys(this.columns, msg.row!);
        if (Object.keys(pks).length === 0) {
          this.panel.webview.postMessage({ type: 'error', message: 'Cannot delete: no primary key found' });
          return;
        }
        try {
          await this.connMgr.deleteRow(
            this.state.connectionId,
            this.state.schema,
            this.state.table,
            pks
          );
          await this.fetchData();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.panel.webview.postMessage({ type: 'error', message: error });
        }
        break;
      }

      case 'refresh':
        await this.fetchData();
        break;

      case 'changePageSize':
        this.state.pageSize = msg.pageSize!;
        this.state.page = 0;
        await this.fetchData();
        break;
    }
  }
}

function getPrimaryKeys(columns: ColumnInfo[], row: Record<string, unknown>): Record<string, unknown> {
  const pks: Record<string, unknown> = {};
  for (const col of columns) {
    if (col.is_primary) {
      pks[col.name] = row[col.name];
    }
  }
  return pks;
}

interface WebviewMessage {
  type: 'navigate' | 'sort' | 'filter' | 'updateRow' | 'insertRow' | 'deleteRow' | 'refresh' | 'changePageSize';
  page?: number;
  column?: string;
  filter?: string;
  row?: Record<string, unknown>;
  updates?: Record<string, unknown>;
  pageSize?: number;
}

function getLoadingHtml(): string {
  return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:40px;text-align:center">
  <p>Loading table data...</p></body></html>`;
}

function getErrorHtml(msg: string): string {
  return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-errorForeground);background:var(--vscode-editor-background);padding:40px">
  <h3>Error loading table</h3><pre>${msg}</pre></body></html>`;
}

function getTableHtml(
  webview: vscode.Webview,
  _extensionUri: vscode.Uri,
  state: TableViewState,
  columns: ColumnInfo[]
): string {
  const columnsJson = JSON.stringify(columns);
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<title>${state.schema}.${state.table}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  /* Toolbar */
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; flex-wrap: wrap; }
  .toolbar-title { font-weight: bold; font-size: 14px; color: var(--vscode-editor-foreground); white-space: nowrap; }
  .toolbar-spacer { flex: 1; }
  .filter-input { padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 2px; font-size: 12px; width: 260px; }
  .filter-input:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { padding: 4px 10px; border: none; border-radius: 2px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .btn-icon { background: transparent; color: var(--vscode-foreground); padding: 4px 6px; }
  .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-errorForeground, #f48771); }
  .btn-danger:hover { opacity: 0.8; }
  select.page-size { padding: 3px 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 2px; font-size: 12px; }

  /* Table container */
  .table-container { flex: 1; overflow: auto; position: relative; }
  table { width: 100%; border-collapse: collapse; table-layout: auto; }
  thead { position: sticky; top: 0; z-index: 10; }
  th { background: var(--vscode-editorGroupHeader-tabsBackground); color: var(--vscode-tab-activeForeground); padding: 6px 10px; text-align: left; font-weight: 600; white-space: nowrap; border-right: 1px solid var(--vscode-panel-border); border-bottom: 2px solid var(--vscode-panel-border); cursor: pointer; user-select: none; font-size: 12px; }
  th:hover { background: var(--vscode-list-hoverBackground); }
  th .sort-indicator { opacity: 0.4; margin-left: 4px; }
  th.sorted .sort-indicator { opacity: 1; }
  td { padding: 4px 10px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top; font-size: 12px; }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  tr.selected td { background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }
  .row-num { color: var(--vscode-descriptionForeground); font-size: 11px; width: 40px; text-align: right; padding-right: 8px; }

  /* Action column */
  th.col-actions, td.col-actions { width: 70px; min-width: 70px; padding: 2px 4px; cursor: default; }
  td.col-actions { display: flex; gap: 4px; align-items: center; }
  .row-btn { padding: 2px 6px; font-size: 11px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 2px; cursor: pointer; }
  .row-btn:hover { opacity: 0.8; }
  .row-btn.del { background: transparent; color: var(--vscode-errorForeground, #f48771); }

  /* Status bar */
  .status-bar { display: flex; align-items: center; gap: 12px; padding: 5px 12px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); font-size: 12px; flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border); }
  .status-bar .page-info { flex: 1; }
  .pagination { display: flex; align-items: center; gap: 4px; }
  .pagination button { padding: 2px 8px; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .pagination button:disabled { opacity: 0.4; cursor: default; }
  .page-display { padding: 0 8px; }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; display: flex; align-items: center; justify-content: center; }
  .modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 20px; min-width: 500px; max-width: 700px; max-height: 80vh; overflow-y: auto; }
  .modal h3 { margin-bottom: 16px; font-size: 14px; }
  .modal-grid { display: grid; grid-template-columns: 150px 1fr; gap: 8px; align-items: center; margin-bottom: 16px; }
  .modal-grid label { font-size: 12px; color: var(--vscode-descriptionForeground); text-align: right; padding-right: 8px; }
  .modal-grid input, .modal-grid textarea { width: 100%; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 2px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
  .modal-grid input:focus, .modal-grid textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .modal-grid input[readonly] { opacity: 0.6; cursor: not-allowed; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* Error/info messages */
  .message { padding: 8px 12px; margin: 8px 12px; border-radius: 2px; font-size: 12px; }
  .message.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder, #f44336); }
  .message.info { background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-inputValidation-infoForeground); }

  .empty-state { text-align: center; padding: 60px 20px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>

<div class="toolbar">
  <span class="toolbar-title">📋 ${state.schema}.<strong>${state.table}</strong></span>
  <input class="filter-input" id="filterInput" placeholder="WHERE clause filter (e.g. id > 5 AND name LIKE '%foo%')" />
  <button class="btn-primary" onclick="applyFilter()">Filter</button>
  <button class="btn-icon" onclick="clearFilter()" title="Clear filter">✕</button>
  <span class="toolbar-spacer"></span>
  <button class="btn-primary" onclick="openInsertModal()">+ New Row</button>
  <button class="btn-icon" onclick="refresh()" title="Refresh">↻ Refresh</button>
  <select class="page-size" onchange="changePageSize(this.value)">
    <option value="50">50 rows</option>
    <option value="100" selected>100 rows</option>
    <option value="250">250 rows</option>
    <option value="500">500 rows</option>
    <option value="1000">1000 rows</option>
  </select>
</div>

<div id="messageArea"></div>

<div class="table-container">
  <table id="dataTable">
    <thead id="tableHead"></thead>
    <tbody id="tableBody"></tbody>
  </table>
  <div id="emptyState" class="empty-state" style="display:none">No rows found</div>
</div>

<div class="status-bar">
  <span class="page-info" id="statusInfo">Loading...</span>
  <div class="pagination">
    <button id="btnFirst" onclick="navigate(0)" title="First page">«</button>
    <button id="btnPrev" onclick="navigate(currentPage - 1)" title="Previous page">‹</button>
    <span class="page-display" id="pageDisplay"></span>
    <button id="btnNext" onclick="navigate(currentPage + 1)" title="Next page">›</button>
    <button id="btnLast" onclick="navigate(lastPage)" title="Last page">»</button>
  </div>
</div>

<!-- Edit/Insert Modal -->
<div class="modal-overlay" id="modal" style="display:none" onclick="closeModalOnOverlay(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <h3 id="modalTitle">Edit Row</h3>
    <div class="modal-grid" id="modalFields"></div>
    <div class="modal-actions">
      <button class="btn-primary" id="modalSaveBtn" onclick="saveModal()">Save</button>
      <button style="background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)" onclick="closeModal()">Cancel</button>
    </div>
  </div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const COLUMNS = ${columnsJson};

  let currentPage = 0;
  let lastPage = 0;
  let currentOrderBy = null;
  let currentOrderDir = 'ASC';
  let modalMode = 'edit'; // 'edit' or 'insert'
  let modalOriginalRow = null;

  // ── Message handler ──────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
      case 'data':
        renderTable(msg);
        break;
      case 'error':
        showMessage(msg.message, 'error');
        break;
      case 'updateSuccess':
        showMessage('Row updated.', 'info');
        break;
      case 'insertSuccess':
        showMessage('Row inserted.', 'info');
        closeModal();
        break;
    }
  });

  // ── Render ───────────────────────────────────────────────────────
  function renderTable(msg) {
    currentPage = msg.page;
    currentOrderBy = msg.orderBy;
    currentOrderDir = msg.orderDir;
    const totalRows = msg.total;
    const pageSize = msg.pageSize;
    lastPage = Math.max(0, Math.ceil(totalRows / pageSize) - 1);

    // Header
    const head = document.getElementById('tableHead');
    const sortIcon = col => {
      if (col !== currentOrderBy) return '<span class="sort-indicator">⇅</span>';
      return '<span class="sort-indicator">' + (currentOrderDir === 'ASC' ? '↑' : '↓') + '</span>';
    };
    head.innerHTML = '<tr>' +
      '<th class="row-num">#</th>' +
      COLUMNS.map(c =>
        '<th class="' + (c.name === currentOrderBy ? 'sorted' : '') + '" onclick="sortBy(\'' + c.name + '\')" title="' + c.type + (c.is_primary ? ' (PK)' : '') + '">' +
        (c.is_primary ? '🔑 ' : '') + escHtml(c.name) + sortIcon(c.name) +
        '</th>'
      ).join('') +
      '<th class="col-actions">Actions</th>' +
      '</tr>';

    // Body
    const body = document.getElementById('tableBody');
    const empty = document.getElementById('emptyState');
    if (msg.rows.length === 0) {
      body.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      const offset = currentPage * pageSize;
      body.innerHTML = msg.rows.map((row, i) =>
        '<tr onclick="selectRow(this)">' +
        '<td class="row-num">' + (offset + i + 1) + '</td>' +
        COLUMNS.map(c =>
          '<td class="' + (row[c.name] === null || row[c.name] === undefined ? 'null' : '') + '" title="' + escAttr(String(row[c.name] ?? '')) + '">' +
          (row[c.name] === null || row[c.name] === undefined ? '<em>NULL</em>' : escHtml(String(row[c.name]))) +
          '</td>'
        ).join('') +
        '<td class="col-actions">' +
        '<button class="row-btn" onclick="event.stopPropagation();openEditModal(' + i + ', this)">Edit</button>' +
        '<button class="row-btn del" onclick="event.stopPropagation();deleteRow(' + i + ', this)" title="Delete row">✕</button>' +
        '</td>' +
        '</tr>'
      ).join('');
      // Store row data on rows for later access
      const rows = body.querySelectorAll('tr');
      msg.rows.forEach((row, i) => {
        rows[i]._rowData = row;
      });
    }

    // Status
    const start = currentPage * pageSize + 1;
    const end = Math.min((currentPage + 1) * pageSize, totalRows);
    document.getElementById('statusInfo').textContent =
      totalRows === 0 ? 'No rows' : 'Rows ' + start + '–' + end + ' of ' + totalRows.toLocaleString();
    document.getElementById('pageDisplay').textContent = (currentPage + 1) + ' / ' + (lastPage + 1);

    document.getElementById('btnFirst').disabled = currentPage === 0;
    document.getElementById('btnPrev').disabled = currentPage === 0;
    document.getElementById('btnNext').disabled = currentPage >= lastPage;
    document.getElementById('btnLast').disabled = currentPage >= lastPage;
  }

  // ── Actions ──────────────────────────────────────────────────────
  function navigate(page) {
    if (page < 0 || page > lastPage) return;
    vscode.postMessage({ type: 'navigate', page });
  }

  function sortBy(col) {
    vscode.postMessage({ type: 'sort', column: col });
  }

  function applyFilter() {
    const val = document.getElementById('filterInput').value.trim();
    vscode.postMessage({ type: 'filter', filter: val });
  }

  function clearFilter() {
    document.getElementById('filterInput').value = '';
    vscode.postMessage({ type: 'filter', filter: '' });
  }

  function refresh() {
    vscode.postMessage({ type: 'refresh' });
  }

  function changePageSize(val) {
    vscode.postMessage({ type: 'changePageSize', pageSize: parseInt(val, 10) });
  }

  document.getElementById('filterInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyFilter();
  });

  function selectRow(tr) {
    document.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
    tr.classList.add('selected');
  }

  // ── Edit Modal ───────────────────────────────────────────────────
  function getRowData(idx) {
    const rows = document.getElementById('tableBody').querySelectorAll('tr');
    return rows[idx]._rowData;
  }

  function openEditModal(idx, btn) {
    modalMode = 'edit';
    const row = getRowData(idx);
    modalOriginalRow = row;
    document.getElementById('modalTitle').textContent = 'Edit Row';
    buildModalFields(row, false);
    document.getElementById('modalSaveBtn').textContent = 'Save Changes';
    document.getElementById('modal').style.display = 'flex';
  }

  function openInsertModal() {
    modalMode = 'insert';
    modalOriginalRow = null;
    document.getElementById('modalTitle').textContent = 'Insert New Row';
    buildModalFields(null, true);
    document.getElementById('modalSaveBtn').textContent = 'Insert Row';
    document.getElementById('modal').style.display = 'flex';
  }

  function buildModalFields(row, isInsert) {
    const container = document.getElementById('modalFields');
    container.innerHTML = COLUMNS.map(col => {
      const val = row ? (row[col.name] === null || row[col.name] === undefined ? '' : String(row[col.name])) : '';
      const isPk = col.is_primary && !isInsert;
      return '<label title="' + col.type + (col.is_primary ? ' PK' : '') + '">' +
        (col.is_primary ? '🔑 ' : '') + escHtml(col.name) +
        '<br><small style="opacity:0.6">' + escHtml(col.type) + '</small>' +
        '</label>' +
        '<input id="field_' + col.name + '" type="text" value="' + escAttr(val) + '"' + (isPk ? ' readonly' : '') + ' placeholder="' + (col.nullable === 'YES' ? 'NULL' : '') + '" />';
    }).join('');
  }

  function closeModal() {
    document.getElementById('modal').style.display = 'none';
  }

  function closeModalOnOverlay(e) {
    if (e.target === document.getElementById('modal')) closeModal();
  }

  function saveModal() {
    if (modalMode === 'edit') {
      const updates = {};
      COLUMNS.filter(c => !c.is_primary).forEach(col => {
        const el = document.getElementById('field_' + col.name);
        updates[col.name] = el.value === '' ? null : el.value;
      });
      vscode.postMessage({ type: 'updateRow', row: modalOriginalRow, updates });
      closeModal();
    } else {
      const row = {};
      COLUMNS.forEach(col => {
        const el = document.getElementById('field_' + col.name);
        row[col.name] = el.value === '' ? null : el.value;
      });
      vscode.postMessage({ type: 'insertRow', row });
    }
  }

  function deleteRow(idx, btn) {
    const row = getRowData(idx);
    if (!confirm('Delete this row?')) return;
    vscode.postMessage({ type: 'deleteRow', row });
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escAttr(s) {
    return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function showMessage(text, kind) {
    const area = document.getElementById('messageArea');
    area.innerHTML = '<div class="message ' + kind + '">' + escHtml(text) + '</div>';
    setTimeout(() => { area.innerHTML = ''; }, 5000);
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { if (document.getElementById('modal').style.display !== 'none') saveModal(); }
  });
</script>
</body>
</html>`;
}

function getNonce(): string {
  return [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
}
