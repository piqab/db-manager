import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager, ColumnInfo } from './connectionManager';
import { importCsvFromFile, importJsonFromFile, DEFAULT_JSON_PARSE_MAX_BYTES } from './streamingImport.js';

// ─── Export ────────────────────────────────────────────────────────────────

export async function exportTableStructure(
  connMgr: ConnectionManager,
  connectionId: string,
  schema: string,
  table: string
): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${table}_structure.sql`),
    filters: { 'SQL': ['sql'], 'All Files': ['*'] },
    title: `Export structure of "${schema}"."${table}"`,
  });
  if (!uri) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting structure of ${table}...`,
      cancellable: false,
    },
    async () => {
      const ddl = await connMgr.getTableStructureDdl(connectionId, schema, table);
      fs.writeFileSync(uri.fsPath, ddl, 'utf8');
      vscode.window.showInformationMessage(
        `Structure saved to ${path.basename(uri.fsPath)}`
      );
    }
  );
}

export async function exportTable(
  connMgr: ConnectionManager,
  connectionId: string,
  schema: string,
  table: string
): Promise<void> {
  const format = await vscode.window.showQuickPick(['CSV', 'JSON', 'SQL'], {
    placeHolder: 'Select export format',
  });
  if (!format) { return; }

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${table}.${format.toLowerCase()}`),
    filters: getFilters(format),
    title: `Export table "${schema}"."${table}"`,
  });
  if (!uri) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Exporting ${table}...`, cancellable: false },
    async () => {
      const columns = await connMgr.getColumns(connectionId, schema, table);
      const result = await connMgr.query(connectionId, `SELECT * FROM "${schema}"."${table}"`);
      const rows = result.rows as Record<string, unknown>[];

      let content: string;
      switch (format) {
        case 'CSV':
          content = rowsToCsv(columns, rows);
          break;
        case 'JSON':
          content = JSON.stringify(rows, null, 2);
          break;
        case 'SQL':
          content = rowsToInsertSql(schema, table, columns, rows);
          break;
        default:
          content = '';
      }

      fs.writeFileSync(uri.fsPath, content, 'utf8');
      vscode.window.showInformationMessage(
        `Exported ${rows.length} rows to ${path.basename(uri.fsPath)}`
      );
    }
  );
}

export async function exportDatabase(
  connMgr: ConnectionManager,
  connectionId: string
): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file('database_dump.sql'),
    filters: { 'SQL Files': ['sql'], 'All Files': ['*'] },
    title: 'Export Database as SQL dump',
  });
  if (!uri) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Exporting database...', cancellable: false },
    async (progress) => {
      const tables = await connMgr.getTables(connectionId);
      const chunks: string[] = [
        '-- DB Manager SQL Dump',
        `-- Generated: ${new Date().toISOString()}`,
        '',
        'SET client_encoding = \'UTF8\';',
        'SET standard_conforming_strings = on;',
        '',
      ];

      for (let i = 0; i < tables.length; i++) {
        const t = tables[i];
        progress.report({
          message: `Table ${i + 1}/${tables.length}: ${t.schema}.${t.name}`,
          increment: (1 / tables.length) * 100,
        });

        const columns = await connMgr.getColumns(connectionId, t.schema, t.name);

        // CREATE TABLE statement
        chunks.push(`-- Table: "${t.schema}"."${t.name}"`);
        chunks.push(`DROP TABLE IF EXISTS "${t.schema}"."${t.name}" CASCADE;`);
        chunks.push(buildCreateTable(t.schema, t.name, columns));
        chunks.push('');

        // INSERT statements
        const result = await connMgr.query(connectionId, `SELECT * FROM "${t.schema}"."${t.name}"`);
        const rows = result.rows as Record<string, unknown>[];
        if (rows.length > 0) {
          chunks.push(rowsToInsertSql(t.schema, t.name, columns, rows));
          chunks.push('');
        }
      }

      fs.writeFileSync(uri.fsPath, chunks.join('\n'), 'utf8');
      vscode.window.showInformationMessage(
        `Database exported to ${path.basename(uri.fsPath)} (${tables.length} tables)`
      );
    }
  );
}

// ─── Import ────────────────────────────────────────────────────────────────

export async function importTable(
  connMgr: ConnectionManager,
  connectionId: string,
  schema: string,
  table: string
): Promise<void> {
  const format = await vscode.window.showQuickPick(['CSV', 'JSON', 'SQL'], {
    placeHolder: 'Select import format',
  });
  if (!format) { return; }

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: getFilters(format),
    title: `Import into "${schema}"."${table}"`,
  });
  if (!uris?.length) { return; }

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: 'Append rows',
        description: 'Keep existing data',
        mode: 'append' as const,
      },
      {
        label: 'Clear then import (DELETE)',
        description: 'Deletes dependent tables first (FK), then this table, then imports',
        mode: 'delete' as const,
      },
      {
        label: 'Clear then import (TRUNCATE CASCADE)',
        description: 'Also removes rows in tables that reference this one (use with care)',
        mode: 'truncate_cascade' as const,
      },
    ],
    { placeHolder: 'Import mode' }
  );
  if (!modePick) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Importing into ${table}...`, cancellable: false },
    async (progress) => {
      const filePath = uris[0].fsPath;
      try {
        if (modePick.mode === 'delete') {
          await connMgr.deleteAllRowsFromTableRespectingFKs(connectionId, schema, table);
        } else if (modePick.mode === 'truncate_cascade') {
          await connMgr.query(
            connectionId,
            `TRUNCATE TABLE "${schema}"."${table}" RESTART IDENTITY CASCADE`
          );
        }

        const jsonParseMax = vscode.workspace
          .getConfiguration('dbManager')
          .get<number>('jsonImportMaxParseBytes', DEFAULT_JSON_PARSE_MAX_BYTES);

        let rowCount = 0;
        switch (format) {
          case 'CSV':
            rowCount = await importCsvFromFile(
              connMgr,
              connectionId,
              schema,
              table,
              filePath,
              parseCsvLine,
              stripCsvBom,
              trimHeaderName
            );
            break;
          case 'JSON':
            rowCount = await importJsonFromFile(
              connMgr,
              connectionId,
              schema,
              table,
              filePath,
              jsonParseMax
            );
            break;
          case 'SQL':
            rowCount = await importSql(connMgr, connectionId, filePath, progress);
            break;
        }

        void vscode.window.showInformationMessage(
          `Imported ${rowCount} rows into "${schema}"."${table}"`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Import failed: ${msg}`);
      }
    }
  );
}

export async function importDatabase(
  connMgr: ConnectionManager,
  connectionId: string
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'SQL Files': ['sql'], 'All Files': ['*'] },
    title: 'Import SQL dump',
  });
  if (!uris?.length) { return; }

  const confirm = await vscode.window.showWarningMessage(
    'This will execute the entire SQL file. Are you sure?',
    { modal: true },
    'Yes, import'
  );
  if (confirm !== 'Yes, import') { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Importing SQL dump...', cancellable: false },
    async (progress) => {
      const filePath = uris[0].fsPath;
      try {
        const { statementsExecuted } = await connMgr.executeScriptBatchedFromFile(connectionId, filePath, {
          onProgress: (done) => {
            progress.report({ message: `${done} statements` });
          },
        });
        void vscode.window.showInformationMessage(
          `SQL dump imported (${statementsExecuted} statements executed)`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Import failed: ${msg}`);
      }
    }
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getFilters(format: string): Record<string, string[]> {
  switch (format) {
    case 'CSV': return { 'CSV Files': ['csv'], 'All Files': ['*'] };
    case 'JSON': return { 'JSON Files': ['json'], 'All Files': ['*'] };
    case 'SQL': return { 'SQL Files': ['sql'], 'All Files': ['*'] };
    default: return { 'All Files': ['*'] };
  }
}

function rowsToCsv(columns: ColumnInfo[], rows: Record<string, unknown>[]): string {
  const header = columns.map(c => csvEscape(c.name)).join(',');
  const lines = rows.map(row =>
    columns.map(c => csvEscape(String(row[c.name] ?? ''))).join(',')
  );
  return [header, ...lines].join('\n');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One INSERT per row so imports run row-by-row (streaming-friendly `;\\n` boundaries). */
function rowsToInsertSql(
  schema: string,
  table: string,
  columns: ColumnInfo[],
  rows: Record<string, unknown>[]
): string {
  if (rows.length === 0) { return ''; }
  const cols = columns.map(c => `"${c.name}"`).join(', ');
  const lines = rows.map(row => {
    const vals = columns.map(c => sqlValue(row[c.name])).join(', ');
    return `INSERT INTO "${schema}"."${table}" (${cols}) VALUES (${vals});`;
  });
  return lines.join('\n');
}

function sqlValue(val: unknown): string {
  if (val === null || val === undefined) { return 'NULL'; }
  if (typeof val === 'number' || typeof val === 'boolean') { return String(val); }
  if (val instanceof Date) { return `'${val.toISOString()}'`; }
  if (typeof val === 'object') { return `'${JSON.stringify(val).replace(/'/g, "''")}'`; }
  return `'${String(val).replace(/'/g, "''")}'`;
}

function buildCreateTable(schema: string, table: string, columns: ColumnInfo[]): string {
  const colDefs = columns.map(c => {
    let def = `  "${c.name}" ${c.type}`;
    if (c.default_value) { def += ` DEFAULT ${c.default_value}`; }
    if (c.nullable === 'NO') { def += ' NOT NULL'; }
    return def;
  });

  const pkCols = columns.filter(c => c.is_primary).map(c => `"${c.name}"`);
  if (pkCols.length > 0) {
    colDefs.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
  }

  return `CREATE TABLE "${schema}"."${table}" (\n${colDefs.join(',\n')}\n);`;
}

/** Remove CR and trim so Windows CRLF / stray \\r in cells do not break column names. */
function stripCarriageReturns(s: string): string {
  return s.replace(/\r/g, '');
}

function stripCsvBom(s: string): string {
  return s.replace(/^\uFEFF/, '');
}

function trimHeaderName(s: string): string {
  return stripCarriageReturns(s).trim();
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(stripCarriageReturns(current));
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(stripCarriageReturns(current));
  return result;
}

async function importSql(
  connMgr: ConnectionManager,
  connectionId: string,
  filePath: string,
  progress?: vscode.Progress<{ message?: string }>
): Promise<number> {
  const { rowsAffected } = await connMgr.executeScriptBatchedFromFile(connectionId, filePath, {
    onProgress: (done) => {
      progress?.report({ message: `${done} SQL statements` });
    },
  });
  return rowsAffected;
}
