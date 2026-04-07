import * as fs from 'fs';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager.js';
import { iterExpandInsertStatements } from './sqlStatementSplit.js';

/** Default cap for one SQL statement while accumulating lines (multi-line CREATE, etc.). */
export const DEFAULT_MAX_SQL_STATEMENT_BYTES = 64 * 1024 * 1024;

/** Max JSON file size to parse as a single array/object (heap). */
export const DEFAULT_JSON_PARSE_MAX_BYTES = 48 * 1024 * 1024;

function isCommentOnlySql(s: string): boolean {
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(l => l.startsWith('--'));
}

async function runExpandedStatements(
  connMgr: ConnectionManager,
  connectionId: string,
  sql: string,
  batchSize: number,
  onProgress: (executed: number) => void,
  state: { executed: number; rowsAffected: number }
): Promise<void> {
  for (const q of iterExpandInsertStatements(sql)) {
    const result = await connMgr.query(connectionId, q);
    const rc = result.rowCount;
    if (typeof rc === 'number' && rc > 0) {
      state.rowsAffected += rc;
    }
    state.executed++;
    if (state.executed % batchSize === 0) {
      onProgress(state.executed);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}

/**
 * Line-oriented SQL import: one statement ends when a line ends with `;` (typical pg_dump / our export).
 * Does not load the whole file into a single string.
 */
export async function importSqlFileStreaming(
  connMgr: ConnectionManager,
  connectionId: string,
  filePath: string,
  options?: { onProgress?: (executed: number) => void }
): Promise<{ statementsExecuted: number; rowsAffected: number }> {
  const batchSize = vscode.workspace.getConfiguration('dbManager').get<number>('sqlImportBatchSize', 100);
  const maxBytes = vscode.workspace.getConfiguration('dbManager').get<number>(
    'maxSqlStatementBytes',
    DEFAULT_MAX_SQL_STATEMENT_BYTES
  );

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let buffer = '';
  const state = { executed: 0, rowsAffected: 0 };
  const onProgress = options?.onProgress ?? (() => {});

  const flush = async (stmt: string) => {
    const t = stmt.trim();
    if (!t.length || isCommentOnlySql(t)) {
      return;
    }
    await runExpandedStatements(connMgr, connectionId, t, batchSize, onProgress, state);
  };

  for await (const line of rl) {
    const addLen = buffer.length ? line.length + 1 : line.length;
    if (buffer.length + addLen > maxBytes) {
      throw new Error(
        `SQL statement exceeds maxSqlStatementBytes (${maxBytes} bytes). ` +
          'Split the dump (one statement per line) or increase dbManager.maxSqlStatementBytes.'
      );
    }
    buffer = buffer.length ? `${buffer}\n${line}` : line;
    if (!line.trimEnd().endsWith(';')) {
      continue;
    }
    const stmt = buffer;
    buffer = '';
    await flush(stmt);
  }

  if (buffer.trim().length > 0) {
    await flush(buffer);
  }

  onProgress(state.executed);
  return { statementsExecuted: state.executed, rowsAffected: state.rowsAffected };
}

/** Read CSV row-by-row; header = first non-empty line. */
export async function importCsvFromFile(
  connMgr: ConnectionManager,
  connectionId: string,
  schema: string,
  table: string,
  filePath: string,
  parseCsvLine: (line: string) => string[],
  stripCsvBom: (s: string) => string,
  trimHeaderName: (s: string) => string
): Promise<number> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers: string[] | null = null;
  let count = 0;

  for await (const line of rl) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.trim()) {
      continue;
    }
    if (!headers) {
      headers = parseCsvLine(trimmed).map(stripCsvBom).map(trimHeaderName);
      continue;
    }
    const values = parseCsvLine(trimmed);
    if (values.length !== headers.length) {
      continue;
    }
    const row: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      const v = values[idx];
      row[h] = v === '' || v === undefined ? null : v;
    });
    await connMgr.insertRow(connectionId, schema, table, row);
    count++;
  }

  return count;
}

/** Small files: JSON.parse. Large files: NDJSON (one JSON object per line). */
export async function importJsonFromFile(
  connMgr: ConnectionManager,
  connectionId: string,
  schema: string,
  table: string,
  filePath: string,
  parseMaxBytes: number
): Promise<number> {
  const st = await fs.promises.stat(filePath);
  if (parseMaxBytes > 0 && st.size <= parseMaxBytes) {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const data = JSON.parse(content) as unknown;
    const rows = Array.isArray(data) ? data : [data];
    let n = 0;
    for (const row of rows as Record<string, unknown>[]) {
      await connMgr.insertRow(connectionId, schema, table, row);
      n++;
    }
    return n;
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    const row = JSON.parse(line) as Record<string, unknown>;
    await connMgr.insertRow(connectionId, schema, table, row);
    count++;
  }
  return count;
}
