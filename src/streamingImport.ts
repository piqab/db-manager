import * as fs from 'fs';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager.js';
import { iterExpandInsertStatements } from './sqlStatementSplit.js';

function normalizeSqlChunk(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Statements completed by semicolon + newline (same as legacy string split). */
function extractStatementsFromBuffer(buffer: string): { statements: string[]; rest: string } {
  const statements: string[] = [];
  const re = /;\s*\n/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    const stmt = buffer.slice(lastIndex, m.index).trim();
    lastIndex = m.index + m[0].length;
    if (stmt.length) {
      statements.push(stmt);
    }
  }
  return { statements, rest: buffer.slice(lastIndex) };
}

function splitSqlRemainder(buffer: string): string[] {
  const trimmed = buffer.trim();
  if (!trimmed.length) {
    return [];
  }
  return trimmed
    .split(/;\s*\n|;\s*$/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Default max tail without `;\\n` inside (one huge statement). */
export const DEFAULT_MAX_SQL_STATEMENT_BYTES = 256 * 1024 * 1024;

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
  onProgress: (statementsRead: number, queriesSent: number) => void,
  state: { sent: number; rowsAffected: number; statementsRead: number }
): Promise<void> {
  for (const q of iterExpandInsertStatements(sql)) {
    const result = await connMgr.query(connectionId, q);
    const rc = result.rowCount;
    if (typeof rc === 'number' && rc > 0) {
      state.rowsAffected += rc;
    }
    state.sent++;
    if (state.sent % batchSize === 0) {
      onProgress(state.statementsRead, state.sent);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}

/**
 * Chunk-streaming SQL import: splits on `;` + newline as data arrives (bounded buffer).
 * Does not require one statement per physical line.
 */
export async function importSqlFileStreaming(
  connMgr: ConnectionManager,
  connectionId: string,
  filePath: string,
  options?: { onProgress?: (statementsRead: number, queriesSent: number) => void }
): Promise<{ statementsExecuted: number; rowsAffected: number }> {
  const batchSize = vscode.workspace.getConfiguration('dbManager').get<number>('sqlImportBatchSize', 100);
  const maxBytes = vscode.workspace.getConfiguration('dbManager').get<number>(
    'maxSqlStatementBytes',
    DEFAULT_MAX_SQL_STATEMENT_BYTES
  );

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  let buffer = '';
  const state = { sent: 0, rowsAffected: 0, statementsRead: 0 };
  const onProgress = options?.onProgress ?? (() => {});

  const flush = async (stmt: string) => {
    const t = stmt.trim();
    if (!t.length || isCommentOnlySql(t)) {
      return;
    }
    await runExpandedStatements(connMgr, connectionId, t, batchSize, onProgress, state);
  };

  const runBatch = async (statements: string[]) => {
    for (let i = 0; i < statements.length; i += batchSize) {
      const end = Math.min(i + batchSize, statements.length);
      for (let j = i; j < end; j++) {
        await flush(statements[j]);
      }
      onProgress(state.statementsRead, state.sent);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };

  for await (const chunk of stream) {
    buffer += normalizeSqlChunk(chunk as string);
    const { statements, rest } = extractStatementsFromBuffer(buffer);
    buffer = rest;
    if (statements.length > 0) {
      state.statementsRead += statements.length;
      await runBatch(statements);
    }
    if (buffer.length > maxBytes && !/;\s*\n/.test(buffer)) {
      throw new Error(
        `SQL tail exceeds maxSqlStatementBytes (${maxBytes} bytes) without a line break after ';'. ` +
          'Use newlines after each statement, split the dump, or increase dbManager.maxSqlStatementBytes.'
      );
    }
  }

  const tailStatements = splitSqlRemainder(buffer);
  if (tailStatements.length > 0) {
    state.statementsRead += tailStatements.length;
    await runBatch(tailStatements);
  }

  onProgress(state.statementsRead, state.sent);
  return { statementsExecuted: state.sent, rowsAffected: state.rowsAffected };
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
