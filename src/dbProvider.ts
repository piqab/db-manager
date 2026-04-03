import * as vscode from 'vscode';
import { ConnectionConfig, ConnectionManager } from './connectionManager';

export type NodeType = 'connection' | 'database' | 'schema-group' | 'schema' | 'table-group' | 'table' | 'view-group' | 'view' | 'column';

export class DbTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly nodeType: NodeType,
    public readonly connectionId: string,
    public readonly schema?: string,
    public readonly tableName?: string,
    public readonly meta?: unknown
  ) {
    super(label, collapsibleState);
    this.contextValue = nodeType;
    this.setupIcon();
  }

  private setupIcon(): void {
    switch (this.nodeType) {
      case 'connection':
        this.iconPath = new vscode.ThemeIcon('server');
        break;
      case 'database':
        this.iconPath = new vscode.ThemeIcon('database');
        break;
      case 'schema-group':
      case 'table-group':
      case 'view-group':
        this.iconPath = new vscode.ThemeIcon('folder');
        break;
      case 'schema':
        this.iconPath = new vscode.ThemeIcon('layers');
        break;
      case 'table':
        this.iconPath = new vscode.ThemeIcon('table');
        this.command = {
          command: 'dbManager.openTable',
          title: 'Open Table',
          arguments: [this],
        };
        break;
      case 'view':
        this.iconPath = new vscode.ThemeIcon('eye');
        this.command = {
          command: 'dbManager.openTable',
          title: 'Open View',
          arguments: [this],
        };
        break;
      case 'column':
        this.iconPath = new vscode.ThemeIcon('symbol-field');
        break;
    }
  }
}

export class DbProvider implements vscode.TreeDataProvider<DbTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DbTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly connMgr: ConnectionManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DbTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DbTreeItem): Promise<DbTreeItem[]> {
    if (!element) {
      return this.getConnectionNodes();
    }

    try {
      switch (element.nodeType) {
        case 'connection':
          return this.getDatabaseNodes(element.connectionId);
        case 'database':
          return this.getSchemaGroupNodes(element.connectionId);
        case 'schema-group':
          return this.getSchemaNodes(element.connectionId);
        case 'schema':
          return this.getObjectGroupNodes(element.connectionId, element.label);
        case 'table-group':
          return this.getTableNodes(element.connectionId, element.schema ?? 'public', 'tables');
        case 'view-group':
          return this.getTableNodes(element.connectionId, element.schema ?? 'public', 'VIEW');
        case 'table':
        case 'view':
          return this.getColumnNodes(element.connectionId, element.schema ?? 'public', element.tableName ?? element.label);
        default:
          return [];
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`DB Manager: ${msg}`);
      return [];
    }
  }

  private getConnectionNodes(): DbTreeItem[] {
    const connections = this.connMgr.getConnections();
    if (connections.length === 0) {
      const item = new DbTreeItem(
        'Add connection...',
        vscode.TreeItemCollapsibleState.None,
        'connection',
        ''
      );
      item.command = { command: 'dbManager.addConnection', title: 'Add Connection', arguments: [] };
      item.iconPath = new vscode.ThemeIcon('add');
      item.contextValue = 'empty';
      return [item];
    }
    return connections.map(
      c =>
        new DbTreeItem(
          `${c.name} (${c.host}:${c.port})`,
          vscode.TreeItemCollapsibleState.Collapsed,
          'connection',
          c.id
        )
    );
  }

  private async getDatabaseNodes(connectionId: string): Promise<DbTreeItem[]> {
    const dbs = await this.connMgr.getDatabases(connectionId);
    return dbs.map(
      db =>
        new DbTreeItem(
          db,
          vscode.TreeItemCollapsibleState.Collapsed,
          'database',
          `${connectionId}::${db}`
        )
    );
  }

  private getSchemaGroupNodes(connectionId: string): DbTreeItem[] {
    return [
      new DbTreeItem(
        'Schemas',
        vscode.TreeItemCollapsibleState.Expanded,
        'schema-group',
        connectionId
      ),
    ];
  }

  private async getSchemaNodes(connectionId: string): Promise<DbTreeItem[]> {
    const result = await this.connMgr.query(
      connectionId,
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       ORDER BY schema_name`
    );
    return result.rows.map(
      row =>
        new DbTreeItem(
          row.schema_name as string,
          vscode.TreeItemCollapsibleState.Collapsed,
          'schema',
          connectionId
        )
    );
  }

  private getObjectGroupNodes(connectionId: string, schema: string): DbTreeItem[] {
    const tablesNode = new DbTreeItem(
      'Tables',
      vscode.TreeItemCollapsibleState.Collapsed,
      'table-group',
      connectionId,
      schema
    );
    const viewsNode = new DbTreeItem(
      'Views',
      vscode.TreeItemCollapsibleState.Collapsed,
      'view-group',
      connectionId,
      schema
    );
    return [tablesNode, viewsNode];
  }

  private async getTableNodes(
    connectionId: string,
    schema: string,
    kind: 'tables' | 'VIEW'
  ): Promise<DbTreeItem[]> {
    const sql =
      kind === 'VIEW'
        ? `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 AND table_type = 'VIEW'
           ORDER BY table_name`
        : `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1
             AND table_type IN ('BASE TABLE', 'FOREIGN TABLE', 'MATERIALIZED VIEW')
           ORDER BY table_name`;
    const result = await this.connMgr.query(connectionId, sql, [schema]);
    const nodeType: NodeType = kind === 'VIEW' ? 'view' : 'table';
    return result.rows.map(
      row =>
        new DbTreeItem(
          row.table_name as string,
          vscode.TreeItemCollapsibleState.Collapsed,
          nodeType,
          connectionId,
          schema,
          row.table_name as string
        )
    );
  }

  private async getColumnNodes(
    connectionId: string,
    schema: string,
    table: string
  ): Promise<DbTreeItem[]> {
    const columns = await this.connMgr.getColumns(connectionId, schema, table);
    return columns.map(col => {
      const label = `${col.name} : ${col.type}${col.is_primary ? ' 🔑' : ''}`;
      const item = new DbTreeItem(
        label,
        vscode.TreeItemCollapsibleState.None,
        'column',
        connectionId,
        schema,
        table
      );
      item.tooltip = [
        `Column: ${col.name}`,
        `Type: ${col.type}`,
        `Nullable: ${col.nullable}`,
        col.default_value ? `Default: ${col.default_value}` : '',
        col.is_primary ? 'Primary Key' : '',
      ]
        .filter(Boolean)
        .join('\n');
      return item;
    });
  }
}
