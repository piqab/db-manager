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
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const instance = new TableViewPanel(panel, connMgr, connectionId, schema, table, context);
    TableViewPanel.panels.set(key, instance);
    panel.onDidDispose(() => TableViewPanel.panels.delete(key));
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

    panel.webview.html = getLoadingHtml(schema, table);
    this.loadAndRender();

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      await this.handleMessage(msg);
    });
  }

  // Load columns + first page, embed everything in HTML — no postMessage timing issues
  private async loadAndRender(): Promise<void> {
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
      this.panel.webview.html = getTableHtml(this.state, this.columns, rows, total);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.html = getErrorHtml(msg);
    }
  }

  // Used for sort / filter / paginate — updates only the data via postMessage
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
      this.panel.webview.postMessage({ type: 'data', rows, total, page: this.state.page, pageSize: this.state.pageSize });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({ type: 'error', message: msg });
    }
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'navigate':
        this.state.page = msg.page!;
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
        this.state.pageSize = msg.pageSize!;
        this.state.page = 0;
        await this.fetchAndPost();
        break;

      case 'updateRow': {
        const pks = getPrimaryKeys(this.columns, msg.row!);
        if (Object.keys(pks).length === 0) {
          this.panel.webview.postMessage({ type: 'error', message: 'Cannot update: no primary key' });
          return;
        }
        try {
          await this.connMgr.updateRow(this.state.connectionId, this.state.schema, this.state.table, pks, msg.updates!);
          await this.fetchAndPost();
        } catch (err) {
          this.panel.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case 'insertRow': {
        try {
          await this.connMgr.insertRow(this.state.connectionId, this.state.schema, this.state.table, msg.row!);
          this.state.page = 0;
          await this.fetchAndPost();
          this.panel.webview.postMessage({ type: 'insertDone' });
        } catch (err) {
          this.panel.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case 'deleteRow': {
        const pks = getPrimaryKeys(this.columns, msg.row!);
        if (Object.keys(pks).length === 0) {
          this.panel.webview.postMessage({ type: 'error', message: 'Cannot delete: no primary key' });
          return;
        }
        try {
          await this.connMgr.deleteRow(this.state.connectionId, this.state.schema, this.state.table, pks);
          await this.fetchAndPost();
        } catch (err) {
          this.panel.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
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

interface WebviewMessage {
  type: 'navigate' | 'sort' | 'filter' | 'updateRow' | 'insertRow' | 'deleteRow' | 'refresh' | 'changePageSize';
  page?: number;
  column?: string;
  filter?: string;
  row?: Record<string, unknown>;
  updates?: Record<string, unknown>;
  pageSize?: number;
}

function safeJson(obj: unknown): string {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}

function getLoadingHtml(schema: string, table: string): string {
  return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:40px;text-align:center">
  <p>Loading <strong>${schema}.${table}</strong>...</p></body></html>`;
}

function getErrorHtml(msg: string): string {
  return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-errorForeground);background:var(--vscode-editor-background);padding:40px">
  <h3>Error</h3><pre>${msg}</pre></body></html>`;
}

function getTableHtml(
  state: TableViewState,
  columns: ColumnInfo[],
  initialRows: Record<string, unknown>[],
  initialTotal: number
): string {
  const colsJson = safeJson(columns);
  const rowsJson = safeJson(initialRows);
  const totalPages = Math.max(1, Math.ceil(initialTotal / state.pageSize));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<title>${state.schema}.${state.table}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; flex-wrap: wrap; }
.toolbar-title { font-weight: bold; font-size: 14px; white-space: nowrap; }
.spacer { flex: 1; }
.filter-input { padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 2px; font-size: 12px; width: 280px; }
.filter-input:focus { outline: 1px solid var(--vscode-focusBorder); }
button { padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); white-space: nowrap; }
button:hover { opacity: 0.85; }
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
select { padding: 3px 6px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #555); border-radius: 2px; font-size: 12px; }

.msg-area { flex-shrink: 0; }
.msg { padding: 6px 12px; font-size: 12px; }
.msg.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border-left: 3px solid var(--vscode-errorForeground); }
.msg.info { background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-inputValidation-infoForeground); border-left: 3px solid var(--vscode-inputValidation-infoForeground); }

.table-wrap { flex: 1; overflow: auto; }
table { width: 100%; border-collapse: collapse; }
thead { position: sticky; top: 0; z-index: 5; }
th { background: var(--vscode-editorGroupHeader-tabsBackground); padding: 5px 10px; text-align: left; font-size: 12px; font-weight: 600; white-space: nowrap; border-right: 1px solid var(--vscode-panel-border); border-bottom: 2px solid var(--vscode-panel-border); cursor: pointer; user-select: none; }
th:hover { background: var(--vscode-list-hoverBackground); }
td { padding: 3px 10px; font-size: 12px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
td.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
td.act { width: 80px; min-width: 80px; }
tr:hover td { background: var(--vscode-list-hoverBackground); }
tr.sel td { background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }
.rn { color: var(--vscode-descriptionForeground); font-size: 11px; text-align: right; width: 40px; padding-right: 6px; }
.rb { font-size: 11px; padding: 1px 5px; margin-right: 2px; }
.rb.del { background: transparent; color: var(--vscode-errorForeground, #f48771); }

.statusbar { display: flex; align-items: center; gap: 10px; padding: 4px 12px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); font-size: 12px; flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border); }
.statusbar .info { flex: 1; }
.pager { display: flex; align-items: center; gap: 4px; }
.pager button { padding: 1px 7px; }
.pager button:disabled { opacity: 0.4; cursor: default; }

/* Modal */
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 50; display: flex; align-items: center; justify-content: center; }
.modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 20px; min-width: 480px; max-width: 660px; max-height: 80vh; overflow-y: auto; }
.modal h3 { margin-bottom: 14px; font-size: 14px; }
.fields { display: grid; grid-template-columns: 140px 1fr; gap: 7px; align-items: center; margin-bottom: 14px; }
.fields label { font-size: 12px; color: var(--vscode-descriptionForeground); text-align: right; padding-right: 8px; }
.fields input { width: 100%; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 2px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
.fields input:focus { outline: 1px solid var(--vscode-focusBorder); }
.fields input[readonly] { opacity: .55; cursor: not-allowed; }
.modal-btns { display: flex; gap: 8px; justify-content: flex-end; }
.empty { text-align: center; padding: 60px 20px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>

<div class="toolbar">
  <span class="toolbar-title">&#128203; ${state.schema}.<strong>${state.table}</strong></span>
  <input class="filter-input" id="fi" placeholder="WHERE filter, e.g.: id > 5 AND name LIKE '%x%'" />
  <button class="btn-primary" onclick="applyFilter()">Filter</button>
  <button onclick="clearFilter()">Clear</button>
  <span class="spacer"></span>
  <button class="btn-primary" onclick="openInsert()">+ Row</button>
  <button onclick="doRefresh()">&#8635; Refresh</button>
  <select id="ps" onchange="changePageSize(this.value)">
    <option value="50">50 rows</option>
    <option value="100" ${state.pageSize===100?'selected':''}>100 rows</option>
    <option value="250">250 rows</option>
    <option value="500">500 rows</option>
    <option value="1000">1000 rows</option>
  </select>
</div>

<div class="msg-area" id="msgArea"></div>

<div class="table-wrap">
  <table>
    <thead id="thead"></thead>
    <tbody id="tbody"></tbody>
  </table>
  <div class="empty" id="empty" style="display:none">No rows found</div>
</div>

<div class="statusbar">
  <span class="info" id="sinfo">Loading...</span>
  <div class="pager">
    <button id="bFirst" onclick="nav(0)">&#171;</button>
    <button id="bPrev" onclick="nav(pg-1)">&#8249;</button>
    <span id="pdisp"></span>
    <button id="bNext" onclick="nav(pg+1)">&#8250;</button>
    <button id="bLast" onclick="nav(lastPg)">&#187;</button>
  </div>
</div>

<div class="overlay" id="overlay" style="display:none" onclick="overlayClick(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <h3 id="mtitle">Edit Row</h3>
    <div class="fields" id="mfields"></div>
    <div class="modal-btns">
      <button class="btn-primary" id="msave" onclick="saveModal()">Save</button>
      <button onclick="closeModal()">Cancel</button>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const COLS = ${colsJson};
let rows = ${rowsJson};
let total = ${initialTotal};
let pg = 0;
let lastPg = ${totalPages - 1};
let pageSize = ${state.pageSize};
let orderBy = ${state.orderBy ? `"${state.orderBy}"` : 'null'};
let orderDir = '${state.orderDir}';
let modalMode = 'edit';
let modalRow = null;

// ── initial render ────────────────────────────────────────────────────────────
renderAll();

// ── messages from extension (sort/filter/paginate updates) ───────────────────
window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'data') {
    rows = m.rows; total = m.total; pg = m.page; pageSize = m.pageSize;
    lastPg = Math.max(0, Math.ceil(total / pageSize) - 1);
    renderBody(); renderStatus();
    showMsg('', '');
  } else if (m.type === 'error') {
    showMsg(m.message, 'error');
  } else if (m.type === 'insertDone') {
    closeModal();
  }
});

// ── render ────────────────────────────────────────────────────────────────────
function renderAll() {
  renderHead(); renderBody(); renderStatus();
}

function renderHead() {
  const si = col => col === orderBy ? (orderDir === 'ASC' ? ' &#8593;' : ' &#8595;') : ' <span style="opacity:.35">&#8645;</span>';
  document.getElementById('thead').innerHTML = '<tr>' +
    '<th class="rn">#</th>' +
    COLS.map(c => '<th onclick="sortBy(\'' + c.name + '\')" title="' + esc(c.type) + (c.is_primary?' PK':'') + '">' +
      (c.is_primary ? '&#128273; ' : '') + esc(c.name) + si(c.name) + '</th>').join('') +
    '<th class="act">Actions</th></tr>';
}

function renderBody() {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  if (!rows.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display = 'none';
  const off = pg * pageSize;
  tbody.innerHTML = rows.map((r, i) =>
    '<tr onclick="selRow(this)">' +
    '<td class="rn">' + (off+i+1) + '</td>' +
    COLS.map(c => {
      const v = r[c.name];
      const isNull = v === null || v === undefined;
      return '<td class="' + (isNull?'null-val':'') + '" title="' + esc(String(v??'')) + '">' +
        (isNull ? '<em>NULL</em>' : esc(String(v))) + '</td>';
    }).join('') +
    '<td class="act"><button class="rb" onclick="event.stopPropagation();editRow(' + i + ')">Edit</button>' +
    '<button class="rb del" onclick="event.stopPropagation();delRow(' + i + ')" title="Delete">&#10005;</button></td>' +
    '</tr>'
  ).join('');
  // store row data
  const trs = tbody.querySelectorAll('tr');
  rows.forEach((r, i) => { trs[i]._d = r; });
}

function renderStatus() {
  const s = total === 0 ? 'No rows' : 'Rows ' + (pg*pageSize+1) + '\u2013' + Math.min((pg+1)*pageSize, total) + ' of ' + total.toLocaleString();
  document.getElementById('sinfo').textContent = s + '  [cols:' + COLS.length + ' rows[]:' + rows.length + ' total:' + total + ']';
  document.getElementById('pdisp').textContent = (pg+1) + ' / ' + (lastPg+1);
  document.getElementById('bFirst').disabled = pg === 0;
  document.getElementById('bPrev').disabled  = pg === 0;
  document.getElementById('bNext').disabled  = pg >= lastPg;
  document.getElementById('bLast').disabled  = pg >= lastPg;
}

// ── actions ───────────────────────────────────────────────────────────────────
function nav(p) { if(p<0||p>lastPg) return; vscode.postMessage({type:'navigate',page:p}); }
function sortBy(col) { vscode.postMessage({type:'sort',column:col}); orderBy=col; renderHead(); }
function applyFilter() { vscode.postMessage({type:'filter',filter:document.getElementById('fi').value.trim()}); }
function clearFilter() { document.getElementById('fi').value=''; vscode.postMessage({type:'filter',filter:''}); }
function doRefresh() { vscode.postMessage({type:'refresh'}); }
function changePageSize(v) { pageSize=+v; vscode.postMessage({type:'changePageSize',pageSize:+v}); }

document.getElementById('fi').addEventListener('keydown', e => { if(e.key==='Enter') applyFilter(); });
function selRow(tr) { document.querySelectorAll('tr.sel').forEach(r=>r.classList.remove('sel')); tr.classList.add('sel'); }

function getRow(i) { return document.getElementById('tbody').querySelectorAll('tr')[i]._d; }

// ── modal ─────────────────────────────────────────────────────────────────────
function editRow(i) {
  modalMode='edit'; modalRow=getRow(i);
  document.getElementById('mtitle').textContent='Edit Row';
  buildFields(modalRow, false);
  document.getElementById('msave').textContent='Save';
  document.getElementById('overlay').style.display='flex';
}
function openInsert() {
  modalMode='insert'; modalRow=null;
  document.getElementById('mtitle').textContent='New Row';
  buildFields(null, true);
  document.getElementById('msave').textContent='Insert';
  document.getElementById('overlay').style.display='flex';
}
function buildFields(row, isInsert) {
  document.getElementById('mfields').innerHTML = COLS.map(c => {
    const v = row ? (row[c.name]===null||row[c.name]===undefined ? '' : String(row[c.name])) : '';
    const ro = c.is_primary && !isInsert;
    return '<label title="' + esc(c.type) + (c.is_primary?' PK':'') + '">' + (c.is_primary?'&#128273; ':'') + esc(c.name) +
      '<br><small style="opacity:.6">' + esc(c.type) + '</small></label>' +
      '<input id="f_' + c.name + '" value="' + escAttr(v) + '"' + (ro?' readonly':'') + ' placeholder="' + (c.nullable==='YES'?'NULL':'') + '">';
  }).join('');
}
function closeModal() { document.getElementById('overlay').style.display='none'; }
function overlayClick(e) { if(e.target===document.getElementById('overlay')) closeModal(); }

function saveModal() {
  if(modalMode==='edit') {
    const upd={};
    COLS.filter(c=>!c.is_primary).forEach(c => {
      const el=document.getElementById('f_'+c.name);
      upd[c.name] = el.value==='' ? null : el.value;
    });
    vscode.postMessage({type:'updateRow',row:modalRow,updates:upd});
    closeModal();
  } else {
    const row={};
    COLS.forEach(c => { const el=document.getElementById('f_'+c.name); row[c.name]=el.value===''?null:el.value; });
    vscode.postMessage({type:'insertRow',row});
  }
}

function delRow(i) {
  if(!confirm('Delete this row?')) return;
  vscode.postMessage({type:'deleteRow',row:getRow(i)});
}

// ── helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function showMsg(text, kind) {
  const a=document.getElementById('msgArea');
  if(!text) { a.innerHTML=''; return; }
  a.innerHTML='<div class="msg ' + kind + '">' + esc(text) + '</div>';
  if(kind!=='error') setTimeout(()=>{a.innerHTML='';},4000);
}

document.addEventListener('keydown', e => {
  if(e.key==='Escape') closeModal();
  if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&document.getElementById('overlay').style.display!=='none') saveModal();
});
</script>
</body>
</html>`;
}
