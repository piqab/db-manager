import * as vscode from 'vscode';
import { Pool, PoolClient, QueryResult } from 'pg';

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
    await this.closePool(id);
    const connections = this.getConnections().filter(c => c.id !== id);
    await this.context.globalState.update(this.storageKey, connections);
  }

  private getPool(config: ConnectionConfig): Pool {
    let pool = this.pools.get(config.id);
    if (!pool) {
      pool = new Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      this.pools.set(config.id, pool);
    }
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
    const config = this.getConnections().find(c => c.id === connectionId);
    if (!config) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    const pool = this.getPool(config);
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
    const config = this.getConnections().find(c => c.id === connectionId);
    if (!config) {
      throw new Error(`Connection ${connectionId} not found`);
    }
    const pool = this.getPool(config);
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
