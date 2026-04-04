import * as vscode from 'vscode';
import { Pool, PoolClient, QueryResult } from 'pg';

interface PgColRow {
  col: string;
  typ: string;
  not_null: boolean;
  def_expr: string | null;
  identity: string;
  generated: string;
}

function quoteIdentPg(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

export class ConnectionManager {
  private pools: Map<string, Pool> = new Map();
  private readonly storageKey = 'dbManager.connections';

  constructor(private readonly context: vscode.ExtensionContext) {}

  getConnections(): ConnectionConfig[] {
    return this.context.globalState.get<ConnectionConfig[]>(this.storageKey, []);
  }

  async saveConnection(config: ConnectionConfig): Promise<void> {
    const connections = this.getConnections();
    const idx = connections.findIndex(c => c.id === config.id);
    if (idx >= 0) {
      connections[idx] = config;
    } else {
      connections.push(config);
    }
    await this.context.globalState.update(this.storageKey, connections);
  }

  async removeConnection(id: string): Promise<void> {
    // Close the main pool and all derived database-specific pools
    for (const key of [...this.pools.keys()]) {
      if (key === id || key.startsWith(`${id}::`)) {
        await this.closePool(key);
      }
    }
    const connections = this.getConnections().filter(c => c.id !== id);
    await this.context.globalState.update(this.storageKey, connections);
  }

  // connectionId may be "realId::database" for database-specific pools
  private parseConnectionId(connectionId: string): { realId: string; database?: string } {
    const idx = connectionId.indexOf('::');
    if (idx === -1) return { realId: connectionId };
    return { realId: connectionId.slice(0, idx), database: connectionId.slice(idx + 2) };
  }

  private getPool(connectionId: string): Pool {
    let pool = this.pools.get(connectionId);
    if (pool) return pool;

    const { realId, database } = this.parseConnectionId(connectionId);
    const config = this.getConnections().find(c => c.id === realId);
    if (!config) throw new Error(`Connection ${realId} not found`);

    pool = new Pool({
      host: config.host,
      port: config.port,
      database: database ?? config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    this.pools.set(connectionId, pool);
    return pool;
  }

  async testConnection(config: ConnectionConfig): Promise<void> {
    const pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
    });
    try {
      const client = await pool.connect();
      client.release();
    } finally {
      await pool.end();
    }
  }

  async query(connectionId: string, sql: string, params: unknown[] = []): Promise<QueryResult> {
    const { realId } = this.parseConnectionId(connectionId);
    if (!this.getConnections().find(c => c.id === realId)) {
      throw new Error(`Connection ${realId} not found`);
    }
    const pool = this.getPool(connectionId);
    const timeout = vscode.workspace.getConfiguration('dbManager').get<number>('queryTimeout', 30000);
    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = ${timeout}`);
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  async withClient<T>(connectionId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const { realId } = this.parseConnectionId(connectionId);
    if (!this.getConnections().find(c => c.id === realId)) {
      throw new Error(`Connection ${realId} not found`);
    }
    const pool = this.getPool(connectionId);
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async getDatabases(connectionId: string): Promise<string[]> {
    const result = await this.query(
      connectionId,
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
    );
    return result.rows.map(r => r.datname as string);
  }

  async getTables(connectionId: string): Promise<{ schema: string; name: string; type: string }[]> {
    const result = await this.query(
      connectionId,
      `SELECT table_schema as schema, table_name as name, table_type as type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`
    );
    return result.rows as { schema: string; name: string; type: string }[];
  }

  /**
   * Tables that reference `schema.table` via foreign keys (directly or transitively),
   * in an order safe for DELETE: deepest dependents first. Excludes self-referential
   * FK rows (same table as parent and child).
   */
  async getReferencingTablesDeleteOrder(
    connectionId: string,
    schema: string,
    table: string
  ): Promise<{ schema: string; name: string }[]> {
    const result = await this.query(
      connectionId,
      `WITH RECURSIVE dependents AS (
         SELECT con.conrelid AS tbl_oid, 1 AS lvl
         FROM pg_constraint con
         WHERE con.contype = 'f'
           AND con.confrelid = (
             SELECT cl.oid
             FROM pg_class cl
             JOIN pg_namespace ns ON ns.oid = cl.relnamespace
             WHERE ns.nspname = $1::name AND cl.relname = $2::name
           )
           AND con.conrelid <> con.confrelid
         UNION ALL
         SELECT con.conrelid, d.lvl + 1
         FROM pg_constraint con
         JOIN dependents d ON con.confrelid = d.tbl_oid
         WHERE con.contype = 'f'
           AND con.conrelid <> con.confrelid
       ),
       ranked AS (
         SELECT tbl_oid, max(lvl) AS max_lvl
         FROM dependents
         GROUP BY tbl_oid
       )
       SELECT ns.nspname AS schema_name, cl.relname AS table_name
       FROM ranked r
       JOIN pg_class cl ON cl.oid = r.tbl_oid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       ORDER BY r.max_lvl DESC, ns.nspname, cl.relname`,
      [schema, table]
    );
    return (result.rows as { schema_name: string; table_name: string }[]).map(r => ({
      schema: r.schema_name,
      name: r.table_name,
    }));
  }

  /** DELETE FROM all tables that reference `schema.table`, then DELETE FROM target. */
  async deleteAllRowsFromTableRespectingFKs(
    connectionId: string,
    schema: string,
    table: string
  ): Promise<void> {
    const refs = await this.getReferencingTablesDeleteOrder(connectionId, schema, table);
    for (const t of refs) {
      await this.query(connectionId, `DELETE FROM "${t.schema}"."${t.name}"`);
    }
    await this.query(connectionId, `DELETE FROM "${schema}"."${table}"`);
  }

  async getColumns(connectionId: string, schema: string, table: string): Promise<ColumnInfo[]> {
    const result = await this.query(
      connectionId,
      `SELECT
         c.column_name as name,
         c.data_type as type,
         c.is_nullable as nullable,
         c.column_default as default_value,
         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku
           ON tc.constraint_name = ku.constraint_name
           AND tc.table_schema = ku.table_schema
           AND tc.table_name = ku.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = $1
           AND tc.table_name = $2
       ) pk ON c.column_name = pk.column_name
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table]
    );
    return result.rows as ColumnInfo[];
  }

  /**
   * CREATE TABLE (and related) DDL for ordinary tables; CREATE [MATERIALIZED] VIEW for views.
   */
  async getTableStructureDdl(connectionId: string, schema: string, table: string): Promise<string> {
    const rel = await this.query(
      connectionId,
      `SELECT c.oid, c.relkind::text AS relkind
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1::name AND c.relname = $2::name`,
      [schema, table]
    );
    if (rel.rows.length === 0) {
      throw new Error(`Relation "${schema}"."${table}" not found`);
    }
    const { oid, relkind } = rel.rows[0] as { oid: number; relkind: string };
    const fq = `${quoteIdentPg(schema)}.${quoteIdentPg(table)}`;
    const header = `-- Structure: ${fq}\n-- Generated: ${new Date().toISOString()}\n\n`;

    if (relkind === 'v') {
      const r = await this.query(
        connectionId,
        `SELECT pg_catalog.pg_get_viewdef($1::regclass, true) AS def`,
        [`${quoteIdentPg(schema)}.${quoteIdentPg(table)}`]
      );
      const def = (r.rows[0] as { def: string }).def;
      return `${header}CREATE OR REPLACE VIEW ${fq} AS\n${def};\n`;
    }
    if (relkind === 'm') {
      const r = await this.query(
        connectionId,
        `SELECT pg_catalog.pg_get_viewdef($1::regclass, true) AS def`,
        [`${quoteIdentPg(schema)}.${quoteIdentPg(table)}`]
      );
      const def = (r.rows[0] as { def: string }).def;
      return `${header}DROP MATERIALIZED VIEW IF EXISTS ${fq};\nCREATE MATERIALIZED VIEW ${fq} AS\n${def};\n`;
    }
    if (relkind === 'f') {
      return `${header}-- Foreign table ${fq}: use pg_dump or server metadata to recreate.\n`;
    }
    if (relkind !== 'r' && relkind !== 'p') {
      return `${header}-- Relation kind "${relkind}" is not supported for structure export.\n`;
    }

    const cols = await this.query(
      connectionId,
      `SELECT
         a.attname::text AS col,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS typ,
         a.attnotnull AS not_null,
         pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS def_expr,
         COALESCE(a.attidentity::text, '') AS identity,
         COALESCE(a.attgenerated::text, '') AS generated
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE n.nspname = $1::name AND c.relname = $2::name
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table]
    );

    const colLines = (cols.rows as PgColRow[]).map(row => {
      let line = `  ${quoteIdentPg(row.col)} ${row.typ}`;
      const id = row.identity;
      const gen = row.generated;
      if (id === 'a' || id === 'd') {
        line += id === 'a' ? ' GENERATED ALWAYS AS IDENTITY' : ' GENERATED BY DEFAULT AS IDENTITY';
      } else if (gen === 's' && row.def_expr) {
        line += ` GENERATED ALWAYS AS (${row.def_expr}) STORED`;
      } else if (row.def_expr != null && String(row.def_expr).length > 0) {
        line += ` DEFAULT ${row.def_expr}`;
      }
      if (row.not_null) {
        line += ' NOT NULL';
      }
      return line;
    });

    const tblConstr = await this.query(
      connectionId,
      `SELECT conname::text AS conname, contype::text AS contype,
              pg_catalog.pg_get_constraintdef(oid, true) AS def
       FROM pg_catalog.pg_constraint
       WHERE conrelid = $1::oid AND contype IN ('p', 'u', 'c')
       ORDER BY CASE contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 ELSE 3 END, conname`,
      [oid]
    );
    const constrLines = (tblConstr.rows as { conname: string; def: string }[]).map(
      r => `  CONSTRAINT ${quoteIdentPg(r.conname)} ${r.def}`
    );

    const fkRows = await this.query(
      connectionId,
      `SELECT conname::text AS conname, pg_catalog.pg_get_constraintdef(oid, true) AS def
       FROM pg_catalog.pg_constraint
       WHERE conrelid = $1::oid AND contype = 'f'
       ORDER BY conname`,
      [oid]
    );

    const idxRows = await this.query(
      connectionId,
      `SELECT pg_catalog.pg_get_indexdef(i.indexrelid, 0, true) AS def
       FROM pg_catalog.pg_index i
       WHERE i.indrelid = $1::oid
         AND NOT i.indisprimary
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_constraint co
           WHERE co.conindid = i.indexrelid
         )
       ORDER BY i.indexrelid::regclass::text`,
      [oid]
    );

    const parts: string[] = [
      header,
      `-- Uncomment to replace existing object:\n-- DROP TABLE IF EXISTS ${fq} CASCADE;\n\n`,
      `CREATE TABLE ${fq} (\n`,
      [...colLines, ...constrLines].join(',\n'),
      '\n);\n',
    ];

    for (const fk of fkRows.rows as { conname: string; def: string }[]) {
      parts.push(
        `\nALTER TABLE ${fq} ADD CONSTRAINT ${quoteIdentPg(fk.conname)} ${fk.def};\n`
      );
    }
    for (const ir of idxRows.rows as { def: string }[]) {
      parts.push(`\n${ir.def};\n`);
    }

    return parts.join('');
  }

  async getTableCount(connectionId: string, schema: string, table: string): Promise<number> {
    const result = await this.query(
      connectionId,
      `SELECT COUNT(*) as count FROM "${schema}"."${table}"`
    );
    return parseInt(result.rows[0].count as string, 10);
  }

  async getTableData(
    connectionId: string,
    schema: string,
    table: string,
    offset: number,
    limit: number,
    orderBy?: string,
    orderDir?: 'ASC' | 'DESC',
    filter?: string
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    let where = filter ? `WHERE ${filter}` : '';
    let order = orderBy ? `ORDER BY "${orderBy}" ${orderDir ?? 'ASC'}` : '';

    const countResult = await this.query(
      connectionId,
      `SELECT COUNT(*) as count FROM "${schema}"."${table}" ${where}`
    );
    const total = parseInt(countResult.rows[0].count as string, 10);

    const dataResult = await this.query(
      connectionId,
      `SELECT * FROM "${schema}"."${table}" ${where} ${order} LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { rows: dataResult.rows as Record<string, unknown>[], total };
  }

  async updateRow(
    connectionId: string,
    schema: string,
    table: string,
    primaryKeys: Record<string, unknown>,
    updates: Record<string, unknown>
  ): Promise<void> {
    const setClauses = Object.keys(updates)
      .map((k, i) => `"${k}" = $${i + 1}`)
      .join(', ');
    const whereClauses = Object.keys(primaryKeys)
      .map((k, i) => `"${k}" = $${Object.keys(updates).length + i + 1}`)
      .join(' AND ');

    const values = [...Object.values(updates), ...Object.values(primaryKeys)];
    await this.query(
      connectionId,
      `UPDATE "${schema}"."${table}" SET ${setClauses} WHERE ${whereClauses}`,
      values
    );
  }

  async insertRow(
    connectionId: string,
    schema: string,
    table: string,
    row: Record<string, unknown>
  ): Promise<void> {
    const cols = Object.keys(row).map(k => `"${k}"`).join(', ');
    const vals = Object.keys(row).map((_, i) => `$${i + 1}`).join(', ');
    await this.query(
      connectionId,
      `INSERT INTO "${schema}"."${table}" (${cols}) VALUES (${vals})`,
      Object.values(row)
    );
  }

  async deleteRow(
    connectionId: string,
    schema: string,
    table: string,
    primaryKeys: Record<string, unknown>
  ): Promise<void> {
    const whereClauses = Object.keys(primaryKeys)
      .map((k, i) => `"${k}" = $${i + 1}`)
      .join(' AND ');
    await this.query(
      connectionId,
      `DELETE FROM "${schema}"."${table}" WHERE ${whereClauses}`,
      Object.values(primaryKeys)
    );
  }

  async executeScript(connectionId: string, sql: string): Promise<QueryResult[]> {
    const statements = sql
      .split(/;\s*\n|;\s*$/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    const results: QueryResult[] = [];
    await this.withClient(connectionId, async (client) => {
      for (const stmt of statements) {
        const result = await client.query(stmt);
        results.push(result);
      }
    });
    return results;
  }

  private async closePool(id: string): Promise<void> {
    const pool = this.pools.get(id);
    if (pool) {
      await pool.end();
      this.pools.delete(id);
    }
  }

  async dispose(): Promise<void> {
    for (const [id] of this.pools) {
      await this.closePool(id);
    }
  }
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: string;
  default_value: string | null;
  is_primary: boolean;
}
