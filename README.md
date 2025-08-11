# Obsidian Notion Importer

Import entries from your Notion databases directly into Obsidian. This plugin allows you to automatically sync your Notion database entries with Obsidian notes, either manually or on a schedule.

## Features

- Import entries from any Notion database
- Multiple database ↔ folder mappings
- Customizable file naming patterns
- Configurable destination folder
- Automatic syncing on a schedule
- Manual import option via ribbon icon
- Preserves basic Notion formatting
- Enhanced bidirectional sync (keep the latest version)
- Smart conflict resolution between Notion and Obsidian

## Setup

1. Install the plugin in Obsidian
2. Create a Notion integration:
   - Go to https://www.notion.so/my-integrations
   - Click "New integration"
   - Give it a name and select the workspace
   - Copy the "Internal Integration Token"
3. Share your Notion database with the integration:
   - Open your database in Notion
   - Click the "..." menu in the top right
   - Click "Add connections"
   - Select your integration
4. Get your database ID:
   - Open your database in Notion
   - The ID is in the URL: `https://www.notion.so/workspace-name/database-id?v=...`
5. Configure the plugin:
   - Open Obsidian settings
   - Go to the "Notion Importer" tab
   - Enter your Notion token
   - Under "Connections (Database ↔ Folder)", click "Add" to create one or more mappings
   - For each mapping, set the Notion Database ID and the destination Obsidian folder
   - Configure other options as desired

## Usage

### Manual Import
Click the database icon in the ribbon to import entries immediately.

### Automatic Import
Enable "Auto Import" in settings and set your desired interval. The plugin will automatically check for updates and import new entries.

### Multiple Databases
- When one or more connections are configured, imports will run for each mapping sequentially (to respect Notion rate limits).
- The destination folder for each mapping will be created automatically if it does not exist.
- Manual imports and auto-imports apply to all configured mappings.
- You can add, edit, or remove mappings in Settings → Notion Importer → Connections.

### Bidirectional Sync
Enable "Bidirectional Sync" in the settings to:
- Sync your local Obsidian changes back to Notion
- Local modifications will update the corresponding Notion pages
- Sync is triggered when auto-import runs or when manually initiated
- Simple conflict detection prevents overwriting newer Notion content
- Use the command palette and search for "Sync Local Changes to Notion" to manually trigger the sync

### File Naming
Use the following patterns in the "File Naming Pattern" setting:
- `{{title}}` - The page title
- `{{date}}` - The current date
- `{{id}}` - The Notion page ID

## Development

```bash
# Install dependencies
npm install

# Start development build
npm run dev

# Build for production
npm run build
```

## License

MIT 