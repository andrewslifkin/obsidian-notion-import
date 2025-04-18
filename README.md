# Obsidian Notion Importer

Import entries from your Notion databases directly into Obsidian. This plugin allows you to automatically sync your Notion database entries with Obsidian notes, either manually or on a schedule.

## Features

- Import entries from any Notion database
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
   - Enter your Notion token and database ID
   - Configure other options as desired

## Usage

### Manual Import
Click the database icon in the ribbon to import entries immediately.

### Automatic Import
Enable "Auto Import" in settings and set your desired interval. The plugin will automatically check for updates and import new entries.

### Bidirectional Sync
Enable "Bidirectional Sync" in the settings to:
- Automatically update Obsidian notes when Notion content changes
- Push changes from Obsidian back to Notion
- Smart version tracking to always keep the latest changes
- Conflict resolution that prioritizes the most recently modified version
- Visual diff view to help you choose which version to keep when conflicts occur

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