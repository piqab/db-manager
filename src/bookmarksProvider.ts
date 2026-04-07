import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager.js';

export interface TableBookmark {
  id: string;
  connectionId: string;
  schema: string;
  tableName: string;
}

const STORAGE_KEY = 'dbManager.tableBookmarks';

export function loadBookmarks(context: vscode.ExtensionContext): TableBookmark[] {
  return context.globalState.get<TableBookmark[]>(STORAGE_KEY, []);
}

async function saveBookmarks(context: vscode.ExtensionContext, list: TableBookmark[]): Promise<void> {
  await context.globalState.update(STORAGE_KEY, list);
}

export async function addTableBookmark(
  context: vscode.ExtensionContext,
  partial: Omit<TableBookmark, 'id'>
): Promise<boolean> {
  const list = loadBookmarks(context);
  const sig = `${partial.connectionId}::${partial.schema}::${partial.tableName}`;
  if (list.some(x => `${x.connectionId}::${x.schema}::${x.tableName}` === sig)) {
    void vscode.window.showInformationMessage('Already in Bookmarks');
    return false;
  }
  list.push({ ...partial, id: randomUUID() });
  await saveBookmarks(context, list);
  return true;
}

export async function removeTableBookmark(context: vscode.ExtensionContext, id: string): Promise<void> {
  const list = loadBookmarks(context).filter(x => x.id !== id);
  await saveBookmarks(context, list);
}

export class BookmarkTreeItem extends vscode.TreeItem {
  constructor(
    public readonly bookmark: TableBookmark,
    connectionLabel: string
  ) {
    super(`${bookmark.schema}.${bookmark.tableName}`, vscode.TreeItemCollapsibleState.None);
    this.description = connectionLabel;
    this.tooltip = `${connectionLabel} — ${bookmark.schema}.${bookmark.tableName}`;
    this.contextValue = 'tableBookmark';
    this.iconPath = new vscode.ThemeIcon('bookmark');
    this.command = {
      command: 'dbManager.openBookmarkedTable',
      title: 'Open Table',
      arguments: [bookmark],
    };
  }
}

export class BookmarksProvider implements vscode.TreeDataProvider<BookmarkTreeItem | vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BookmarkTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connMgr: ConnectionManager
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BookmarkTreeItem | vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<(BookmarkTreeItem | vscode.TreeItem)[]> {
    const list = loadBookmarks(this.context);
    if (list.length === 0) {
      const hint = new vscode.TreeItem(
        'No bookmarks yet',
        vscode.TreeItemCollapsibleState.None
      );
      hint.description = 'Right-click a table → Bookmark table';
      hint.iconPath = new vscode.ThemeIcon('info');
      hint.contextValue = 'bookmarkEmpty';
      return [hint];
    }
    const conns = this.connMgr.getConnections();
    return list.map(b => {
      const c = conns.find(x => x.id === b.connectionId);
      const label = c?.name ?? b.connectionId;
      return new BookmarkTreeItem(b, label);
    });
  }
}
