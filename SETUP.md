# DB Manager — Setup & Run

## Prerequisites

Install [Node.js](https://nodejs.org/) (v18+) if you haven't already.

## Install & Build

```bash
cd db-manager
npm install

# Однократная сборка в один файл out/extension.js
npm run bundle

# Сборка для публикации (с минификацией)
npm run bundle -- --production
```

## Run in VSCode (Development)

1. Open the `db-manager` folder in VSCode
2. Press **F5** — this launches an Extension Development Host
3. The DB Manager icon appears in the Activity Bar (left sidebar)

## Package as .vsix (for installation)

```bash
npm install -g @vscode/vsce
vsce package
# Produces db-manager-0.1.0.vsix
```

Install from VSIX:
- In VSCode: `Ctrl+Shift+P` → "Extensions: Install from VSIX..."

## Features

### Connections
- Add/remove PostgreSQL connections (stored securely in VSCode global state)
- Test connection before saving
- SSL support

### Tree View
- Browse databases → schemas → tables/views → columns
- Primary key indicators 🔑

### Table Viewer
- Paginated data grid (configurable page size: 50–1000 rows)
- Sort by any column (click header)
- Filter with raw WHERE clause
- **Edit** rows inline (double-click or Edit button)
- **Insert** new rows
- **Delete** rows

### SQL Query Editor
- Right-click database → "Open SQL Query Editor"
- Multi-statement execution (separated by `;`)
- Results shown as a grid
- `Ctrl+Enter` to run

### Import / Export

**Export Table:**
- Right-click table → "Export Table"
- Formats: **CSV**, **JSON**, **SQL** (INSERT statements)

**Import into Table:**
- Right-click table → "Import into Table"  
- Formats: **CSV**, **JSON**, **SQL**
- Modes: Append or Truncate-then-import

**Export Database:**
- Right-click database → "Export Database"
- Generates full SQL dump (CREATE TABLE + INSERT for all tables)

**Import Database:**
- Right-click database → "Import Database"
- Executes any SQL file

### Other
- Truncate Table (empties all rows)
- Drop Table (removes table entirely)

## Configuration

In VSCode Settings (`Ctrl+,`):

| Setting | Default | Description |
|---------|---------|-------------|
| `dbManager.pageSize` | 100 | Rows per page in table viewer |
| `dbManager.queryTimeout` | 30000 | Query timeout (ms) |
