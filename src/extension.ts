import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { DbProvider, DbTreeItem } from './dbProvider';
import {
  BookmarkTreeItem,
  BookmarksProvider,
  TableBookmark,
  addTableBookmark,
  removeTableBookmark,
} from './bookmarksProvider.js';
import { TableViewPanel } from './panels/tableViewPanel';
import { ConnectionPanel } from './panels/connectionPanel';
import { QueryEditorPanel } from './panels/queryEditorPanel';
import {
  exportTable,
  exportTableStructure,
  exportDatabase,
  importTable,
  importDatabase,
} from './importExport';

export function activate(context: vscode.ExtensionContext): void {
  const connMgr = new ConnectionManager(context);
  const provider = new DbProvider(connMgr);

  // Register tree view
  const treeView = vscode.window.createTreeView('dbManagerConnections', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  treeView.description = `v${context.extension.packageJSON.version}`;
  context.subscriptions.push(treeView);

  const bookmarksProvider = new BookmarksProvider(context, connMgr);
  const bookmarksTreeView = vscode.window.createTreeView('dbManagerBookmarks', {
    treeDataProvider: bookmarksProvider,
  });
  context.subscriptions.push(bookmarksTreeView);

  // ── Commands ──────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.addConnection', () => {
      ConnectionPanel.show(context, connMgr, () => provider.refresh());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.connectConnection', async (item: DbTreeItem) => {
      if (!item?.connectionId || item.nodeType !== 'connection') {
        return;
      }
      const conn = connMgr.getConnections().find(c => c.id === item.connectionId);
      const name = conn?.name ?? item.connectionId;
      try {
        await connMgr.connectConnection(item.connectionId);
        void vscode.window.showInformationMessage(`Подключено: ${name}`);
        provider.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Не удалось подключиться (${name}): ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.disconnectConnection', async (item: DbTreeItem) => {
      if (!item?.connectionId || item.nodeType !== 'connection') {
        return;
      }
      const conn = connMgr.getConnections().find(c => c.id === item.connectionId);
      const name = conn?.name ?? item.connectionId;
      await connMgr.disconnectPools(item.connectionId);
      void vscode.window.showInformationMessage(`Отключено: ${name}`);
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.removeConnection', async (item: DbTreeItem) => {
      const connections = connMgr.getConnections();
      const conn = connections.find(c => c.id === item.connectionId);
      const name = conn?.name ?? item.connectionId;

      const answer = await vscode.window.showWarningMessage(
        `Remove connection "${name}"?`,
        { modal: true },
        'Remove'
      );
      if (answer !== 'Remove') { return; }
      await connMgr.removeConnection(item.connectionId);
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.refreshConnections', () => {
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.openTable', (item: DbTreeItem) => {
      TableViewPanel.show(
        context,
        connMgr,
        item.connectionId,
        item.schema ?? 'public',
        item.tableName ?? item.label as string
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.openBookmarkedTable', (b: TableBookmark) => {
      if (!b?.connectionId) {
        return;
      }
      TableViewPanel.show(context, connMgr, b.connectionId, b.schema, b.tableName);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.addTableBookmark', async (item: DbTreeItem) => {
      if (!item?.connectionId || (item.nodeType !== 'table' && item.nodeType !== 'view')) {
        return;
      }
      const ok = await addTableBookmark(context, {
        connectionId: item.connectionId,
        schema: item.schema ?? 'public',
        tableName: item.tableName ?? (item.label as string),
      });
      if (ok) {
        bookmarksProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.removeTableBookmark', async (item: BookmarkTreeItem) => {
      if (!item?.bookmark) {
        return;
      }
      await removeTableBookmark(context, item.bookmark.id);
      bookmarksProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.exportTableStructure', async (item: DbTreeItem) => {
      await exportTableStructure(
        connMgr,
        item.connectionId,
        item.schema ?? 'public',
        item.tableName ?? item.label as string
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.exportTable', async (item: DbTreeItem) => {
      await exportTable(
        connMgr,
        item.connectionId,
        item.schema ?? 'public',
        item.tableName ?? item.label as string
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.importTable', async (item: DbTreeItem) => {
      await importTable(
        connMgr,
        item.connectionId,
        item.schema ?? 'public',
        item.tableName ?? item.label as string
      );
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.exportDatabase', async (item: DbTreeItem) => {
      await exportDatabase(connMgr, item.connectionId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.importDatabase', async (item: DbTreeItem) => {
      await importDatabase(connMgr, item.connectionId);
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.openQueryEditor', (item: DbTreeItem) => {
      QueryEditorPanel.show(
        context,
        connMgr,
        item.connectionId,
        item.label as string
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.truncateTable', async (item: DbTreeItem) => {
      const table = item.tableName ?? item.label as string;
      const schema = item.schema ?? 'public';
      const answer = await vscode.window.showWarningMessage(
        `Truncate table "${schema}"."${table}"? All rows will be deleted.`,
        { modal: true },
        'Truncate'
      );
      if (answer !== 'Truncate') { return; }
      try {
        await connMgr.query(item.connectionId, `TRUNCATE TABLE "${schema}"."${table}"`);
        vscode.window.showInformationMessage(`Table "${schema}"."${table}" truncated.`);
        provider.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Truncate failed: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbManager.dropTable', async (item: DbTreeItem) => {
      const table = item.tableName ?? item.label as string;
      const schema = item.schema ?? 'public';
      const answer = await vscode.window.showWarningMessage(
        `Drop table "${schema}"."${table}"? This cannot be undone!`,
        { modal: true },
        'Drop Table'
      );
      if (answer !== 'Drop Table') { return; }
      try {
        await connMgr.query(item.connectionId, `DROP TABLE "${schema}"."${table}"`);
        vscode.window.showInformationMessage(`Table "${schema}"."${table}" dropped.`);
        provider.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Drop failed: ${msg}`);
      }
    })
  );

  // Cleanup
  context.subscriptions.push({
    dispose: () => connMgr.dispose(),
  });
}

export function deactivate(): void {}
