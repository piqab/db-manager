# DB Manager

A VSCode extension for managing PostgreSQL databases — browse, edit, query, import and export data directly from the editor.

## Features

### Connection Management
- Add/remove multiple PostgreSQL connections
- Connections stored securely in VSCode global state
- Test connection before saving
- SSL support

### Tree View
- Browse: connections → databases → schemas → tables/views → columns
- Primary key indicators shown in column list

### Table Viewer
- Paginated data grid (configurable: 50–1000 rows per page)
- Sort by any column (click header)
- Filter rows with a raw `WHERE` clause
- Edit rows inline (double-click cell or use Edit button)
- Insert new rows
- Delete rows

### SQL Query Editor
- Right-click a database → "Open SQL Query Editor"
- Multi-statement execution (statements separated by `;`)
- Results displayed as a data grid
- `Ctrl+Enter` to execute

### Import / Export

| Action | Trigger | Formats |
|---|---|---|
| Export table | Right-click table → Export Table | CSV, JSON, SQL (INSERT statements) |
| Import into table | Right-click table → Import into Table | CSV, JSON, SQL |
| Export database | Right-click database → Export Database | SQL dump (CREATE + INSERT) |
| Import database | Right-click database → Import Database | SQL file |

Import modes: **Append** or **Truncate then import**.

### Table Operations
- **Truncate Table** — removes all rows, keeps structure
- **Drop Table** — removes the table entirely

## Installation

### From VSIX

```bash
npm install
npm run bundle
npm install -g @vscode/vsce
vsce package
# Produces db-manager-0.1.0.vsix
```

Then in VSCode: `Ctrl+Shift+P` → **Extensions: Install from VSIX...**

### Development

1. Open the `db-manager` folder in VSCode
2. Press **F5** to launch an Extension Development Host

## Configuration

| Setting | Default | Description |
|---|---|---|
| `dbManager.pageSize` | `100` | Rows per page in table viewer |
| `dbManager.queryTimeout` | `30000` | Query timeout (ms) |

Settings are available via `Ctrl+,` → search "DB Manager".

## Requirements

- VSCode 1.85+
- Node.js 18+ (for building)
- PostgreSQL database
