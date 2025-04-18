import { App, Plugin, PluginSettingTab, Setting, requestUrl, Notice, TFolder, moment, SearchComponent, TFile, TextComponent, SuggestModal, Modal, ButtonComponent } from 'obsidian';
import { Client } from '@notionhq/client';
import { PageObjectResponse, BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';

interface NotionImporterSettings {
    notionToken: string;
    databaseId: string;
    destinationFolder: string;
    fileNamingPattern: string;
    includeDateInFilename: boolean;
    dateFormat: string;
    datePosition: 'prefix' | 'suffix';
    dateSeparator: string;
    dateSource: 'created' | 'current';
    autoImport: boolean;
    importInterval: number; // in minutes
    useTemplate: boolean;
    templatePath: string;
    enableSync: boolean;  // New setting for enabling bi-directional sync
}

const DEFAULT_SETTINGS: NotionImporterSettings = {
    notionToken: '',
    databaseId: '',
    destinationFolder: 'Notion Imports',
    fileNamingPattern: '{{title}}',
    includeDateInFilename: true,
    dateFormat: 'YYYY-MM-DD',
    datePosition: 'prefix',
    dateSeparator: '--',
    dateSource: 'created',
    autoImport: false,
    importInterval: 60,
    useTemplate: false,
    templatePath: '',
    enableSync: false  // Default to false for safety
}

export default class NotionImporterPlugin extends Plugin {
    settings: NotionImporterSettings;
    notionClient: Client;
    importInterval: number;

    async onload() {
        await this.loadSettings();
        
        // Add settings tab
        this.addSettingTab(new NotionImporterSettingTab(this.app, this));

        // Add styles for the diff view
        this.addStyles();

        // Add ribbon icon
        this.addRibbonIcon('database', 'Import from Notion', () => {
            this.importFromNotion();
        });

        // Add command palette options
        this.addCommand({
            id: 'notion-importer-fetch',
            name: 'Fetch from Notion Database',
            callback: () => {
                this.importFromNotion();
            }
        });

        this.addCommand({
            id: 'notion-sync-current-file',
            name: 'Sync Current File to Notion',
            checkCallback: (checking: boolean) => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && this.settings.enableSync) {
                    if (!checking) {
                        this.syncFileToNotion(activeFile);
                    }
                    return true;
                }
                return false;
            }
        });

        // Initialize Notion client with custom fetch implementation
        const customFetch = async (url: string, options: any) => {
            try {
                console.log('Making request to:', url);
                console.log('With options:', {
                    method: options.method,
                    headers: options.headers,
                    body: options.body ? JSON.parse(options.body) : null
                });

                const response = await requestUrl({
                    url,
                    method: options.method,
                    headers: options.headers,
                    body: options.body
                });
                
                return {
                    ok: response.status >= 200 && response.status < 300,
                    status: response.status,
                    json: async () => response.json,
                    text: async () => response.text
                };
            } catch (error: any) {
                console.error('Request failed:', {
                    url,
                    method: options.method,
                    error: error.message,
                    status: error.status,
                    response: error.response
                });
                throw error;
            }
        };

        this.notionClient = new Client({
            auth: this.settings.notionToken,
            fetch: customFetch as any
        });

        // Register file event handlers for sync
        if (this.settings.enableSync) {
            this.registerEvent(
                this.app.vault.on('modify', (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.handleFileModification(file);
                    }
                })
            );

            this.registerEvent(
                this.app.vault.on('rename', (file, oldPath) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.handleFileRename(file, oldPath);
                    }
                })
            );
        }

        // Setup auto-import if enabled
        if (this.settings.autoImport) {
            this.startAutoImport();
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async ensureFolderExists(folderPath: string): Promise<void> {
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            console.log('Creating folder:', folderPath);
            await this.app.vault.createFolder(folderPath);
        }
    }

    async findFileByNotionPageId(pageId: string): Promise<TFile | null> {
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (frontmatterMatch) {
                const frontmatter = frontmatterMatch[1];
                if (frontmatter.includes(`notion_page_id: "${pageId}"`) || frontmatter.includes(`notion_page_id: ${pageId}`)) {
                    return file;
                }
            }
        }
        return null;
    }

    async importFromNotion() {
        try {
            // Validate settings
            if (!this.settings.notionToken) {
                new Notice('Please set your Notion integration token in settings');
                return;
            }
            if (!this.settings.databaseId) {
                new Notice('Please set your Notion database ID in settings');
                return;
            }

            // Ensure destination folder exists
            await this.ensureFolderExists(this.settings.destinationFolder);

            // Test database access
            try {
                console.log('Testing database access with ID:', this.settings.databaseId);
                await this.notionClient.databases.retrieve({
                    database_id: this.settings.databaseId,
                });
            } catch (error: any) {
                console.error('Database access error:', error);
                if (error.status === 404) {
                    new Notice(`Database not found (404). ID: ${this.settings.databaseId}. Please check your database ID and make sure the integration has access to it.`);
                } else if (error.status === 401) {
                    new Notice('Invalid integration token (401). Please check your Notion integration token.');
                } else {
                    new Notice(`Error accessing database: ${error.message}`);
                }
                return;
            }

            console.log('Querying database...');
            const response = await this.notionClient.databases.query({
                database_id: this.settings.databaseId,
            });

            console.log('Database query response:', response);

            if (!response.results || response.results.length === 0) {
                new Notice('No entries found in the database');
                return;
            }

            console.log(`Found ${response.results.length} entries in database`);

            for (const page of response.results) {
                console.log('Processing page:', page);
                if ('properties' in page) {
                    // Log all available properties
                    console.log('Available properties:', Object.keys(page.properties));
                    
                    // Find the title property and created date
                    let titleProperty = null;
                    let createdDate = new Date().toISOString();
                    
                    // Try to get created time from page metadata if available
                    if ('properties' in page && 'created_time' in page) {
                        createdDate = (page as PageObjectResponse).created_time;
                    }
                    
                    for (const [key, prop] of Object.entries(page.properties)) {
                        if (prop.type === 'title') {
                            titleProperty = prop;
                            console.log('Found title property:', key, prop);
                        }
                        // Check for date property that might override created_time
                        if (prop.type === 'date' && prop.date?.start) {
                            createdDate = prop.date.start;
                        }
                    }

                    if (titleProperty && Array.isArray(titleProperty.title)) {
                        const title = titleProperty.title[0]?.plain_text || 'Untitled';
                        console.log('Page title:', title);
                        const content = await this.getPageContent(page.id);
                        console.log('Page content:', content);
                        
                        // Check if this Notion page has already been imported
                        const existingFile = await this.findFileByNotionPageId(page.id);
                        if (existingFile) {
                            console.log('Page already imported at:', existingFile.path);
                            
                            // Check if the Notion version is newer than the local version
                            // Get last updated time from Notion
                            let notionUpdatedTime = (page as PageObjectResponse).last_edited_time;
                            console.log('Notion last edited time:', notionUpdatedTime);
                            
                            // Get local file's modification time
                            const localStat = await this.app.vault.adapter.stat(existingFile.path);
                            const localModifiedTime = localStat ? moment(localStat.mtime).format() : moment().format();
                            console.log('Local file modified time:', localModifiedTime);
                            
                            // Simply compare modification times without checking content
                            if (moment(notionUpdatedTime).isAfter(localModifiedTime)) {
                                console.log('Notion version is newer, updating local file');
                                const updatedContent = await this.getPageContent(page.id);
                                await this.app.vault.modify(existingFile, updatedContent);
                                new Notice(`Updated ${existingFile.basename} from Notion (newer version found)`);
                            } else if (moment(localModifiedTime).isAfter(notionUpdatedTime)) {
                                console.log('Local version is newer, syncing to Notion');
                                // Sync local changes back to Notion
                                await this.syncFileToNotion(existingFile);
                                new Notice(`Synced local changes for ${existingFile.basename} to Notion`);
                            } else {
                                console.log('Both versions have the same timestamp, no update needed');
                            }
                            continue;
                        }

                        const fileName = this.generateFileName(title, createdDate);
                        console.log('Generated filename:', fileName);
                        
                        const filePath = `${this.settings.destinationFolder}/${fileName}.md`;
                        console.log('Creating file at:', filePath);
                        
                        try {
                            await this.app.vault.create(filePath, content);
                            console.log('Successfully created file:', filePath);
                            new Notice('Successfully imported from Notion');
                        } catch (error) {
                            console.error('Error creating file:', error);
                            new Notice(`Error creating file ${fileName}: ${error.message}`);
                        }
                    } else {
                        console.log('Skipping page - no title property found');
                        console.log('Available properties:', page.properties);
                    }
                } else {
                    console.log('Skipping page - no properties found');
                }
            }
        } catch (error: any) {
            console.error('Error importing from Notion:', error);
            new Notice(`Error importing from Notion: ${error.message}`);
        }
    }

    async getPageContent(pageId: string): Promise<string> {
        console.log('Fetching content for page:', pageId);
        const blocks = await this.notionClient.blocks.children.list({
            block_id: pageId,
            page_size: 100
        });

        let allBlocks = [...blocks.results];
        let nextCursor = blocks.next_cursor;

        // Fetch all blocks using pagination
        while (nextCursor) {
            const moreBlocks = await this.notionClient.blocks.children.list({
                block_id: pageId,
                start_cursor: nextCursor,
                page_size: 100
            });
            allBlocks = [...allBlocks, ...moreBlocks.results];
            nextCursor = moreBlocks.next_cursor;
        }

        console.log('Page blocks:', allBlocks);

        let content = '';
        let frontmatterFields: Record<string, string> = {};
        let templateContent = '';

        // Get template content if enabled
        if (this.settings.useTemplate && this.settings.templatePath) {
            try {
                const templateFile = this.app.vault.getAbstractFileByPath(this.settings.templatePath);
                if (templateFile && templateFile instanceof TFile) {
                    templateContent = await this.app.vault.read(templateFile);
                    // Extract template frontmatter if it exists
                    const templateFrontmatter = templateContent.match(/^---\n([\s\S]*?)\n---\n/);
                    if (templateFrontmatter) {
                        // Parse template frontmatter
                        const templateFields = templateFrontmatter[1]
                            .split('\n')
                            .filter(line => line.includes(':'))
                            .reduce((acc, line) => {
                                const [key, ...values] = line.split(':');
                                acc[key.trim()] = values.join(':').trim();
                                return acc;
                            }, {} as Record<string, string>);
                        
                        // Merge template frontmatter fields
                        frontmatterFields = { ...frontmatterFields, ...templateFields };
                        
                        // Remove frontmatter from template content
                        templateContent = templateContent.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
                    }
                }
            } catch (error) {
                console.error('Error reading template:', error);
            }
        }

        // Add page metadata
        const page = await this.notionClient.pages.retrieve({ page_id: pageId });
        if ('properties' in page) {
            // Add required frontmatter fields
            frontmatterFields['imported_from'] = 'notion';
            frontmatterFields['notion_page_id'] = pageId;
            frontmatterFields['last_edited_time'] = page.last_edited_time;
            
            // Add title to frontmatter for Auto Note Mover
            for (const [key, prop] of Object.entries(page.properties)) {
                if (prop.type === 'title' && prop.title.length > 0) {
                    const value = prop.title.map((t: any) => t.plain_text).join('');
                    frontmatterFields['title'] = value;
                    break;
                }
            }
            
            // Add other properties
            for (const [key, prop] of Object.entries(page.properties)) {
                if (prop.type === 'title') continue; // Skip title as we already added it
                
                // Escape special characters in property keys
                const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
                
                if (prop.type === 'date' && prop.date) {
                    frontmatterFields[safeKey] = prop.date.start;
                } else if (prop.type === 'rich_text' && prop.rich_text.length > 0) {
                    const value = prop.rich_text.map((t: any) => t.plain_text).join('');
                    frontmatterFields[safeKey] = value;
                }
            }

            // Build frontmatter string
            content += '---\n';
            for (const [key, value] of Object.entries(frontmatterFields)) {
                // Properly quote values that need it
                const needsQuotes = value.includes('\n') || value.includes('"') || value.includes("'") || value.includes(':');
                const quotedValue = needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
                content += `${key}: ${quotedValue}\n`;
            }
            content += '---\n\n';
        }

        // Add template content if it exists
        if (templateContent) {
            content += templateContent + '\n\n';
        }

        // Group blocks by type for better formatting
        let currentListType = '';
        let formattedContent = '';
        let indentLevel = 0;
        
        for (const block of allBlocks) {
            if (!('type' in block)) continue;
            
            // Get children blocks if they exist
            let children: any[] = [];
            if ('has_children' in block && block.has_children) {
                const childBlocks = await this.notionClient.blocks.children.list({
                    block_id: block.id
                });
                children = childBlocks.results;
            }
            
            const markdown = await this.blockToMarkdown(block as BlockObjectResponse, children);
            if (!markdown) continue;

            // Handle list continuity and indentation
            if (['bulleted_list_item', 'numbered_list_item', 'to_do'].includes(block.type)) {
                if (currentListType !== block.type) {
                    if (currentListType) formattedContent += '\n';
                    currentListType = block.type;
                    indentLevel = 0;
                }
                formattedContent += markdown + '\n';
            } else {
                if (currentListType) {
                    currentListType = '';
                    indentLevel = 0;
                    formattedContent += '\n';
                }
                formattedContent += markdown + '\n\n';
            }
        }

        content += formattedContent.trim();
        console.log('Generated markdown content:', content);
        return content;
    }

    async blockToMarkdown(block: BlockObjectResponse, children: any[] = []): Promise<string> {
        console.log('Converting block to markdown:', block);
        
        const processChildren = async (childBlocks: any[]): Promise<string> => {
            let childContent = '';
            for (const child of childBlocks) {
                if (!('type' in child)) continue;
                
                // Get nested children
                let nestedChildren: any[] = [];
                if ('has_children' in child && child.has_children) {
                    const nestedBlocks = await this.notionClient.blocks.children.list({
                        block_id: child.id
                    });
                    nestedChildren = nestedBlocks.results;
                }
                
                const childMarkdown = await this.blockToMarkdown(child as BlockObjectResponse, nestedChildren);
                if (childMarkdown) {
                    // Add indentation for child items
                    childContent += childMarkdown.split('\n').map(line => `    ${line}`).join('\n') + '\n';
                }
            }
            return childContent;
        };
        
        let content = '';
        switch (block.type) {
            case 'paragraph':
                content = block.paragraph.rich_text.map((text: any) => text.plain_text).join('');
                break;
            
            case 'heading_1':
                content = `# ${block.heading_1.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'heading_2':
                content = `## ${block.heading_2.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'heading_3':
                content = `### ${block.heading_3.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'bulleted_list_item':
                content = `- ${block.bulleted_list_item.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'numbered_list_item':
                content = `1. ${block.numbered_list_item.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'to_do':
                const checked = block.to_do.checked ? 'x' : ' ';
                content = `- [${checked}] ${block.to_do.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'toggle':
                content = `- ${block.toggle.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'code':
                content = `\`\`\`${block.code.language}\n${block.code.rich_text.map((text: any) => text.plain_text).join('')}\n\`\`\``;
                break;
            
            case 'quote':
                content = `> ${block.quote.rich_text.map((text: any) => text.plain_text).join('')}`;
                break;
            
            case 'divider':
                content = '---';
                break;
            
            default:
                console.log('Unhandled block type:', block.type);
                return '';
        }

        // Process children if they exist
        if (children && children.length > 0) {
            const childContent = await processChildren(children);
            if (childContent) {
                content += '\n' + childContent;
            }
        }

        return content;
    }

    generateFileName(title: string, createdDate?: string): string {
        let fileName = this.settings.fileNamingPattern
            .replace('{{title}}', title)
            .replace(/[^a-zA-Z0-9\s]/g, ' ') // Replace special chars with spaces
            .replace(/\s+/g, ' ') // Replace multiple spaces with single space
            .trim() // Remove leading/trailing spaces
            .toLowerCase();

        if (this.settings.includeDateInFilename) {
            const dateStr = this.settings.dateSource === 'created' && createdDate ? 
                moment(createdDate).format(this.settings.dateFormat) : 
                moment().format(this.settings.dateFormat);

            fileName = this.settings.datePosition === 'prefix' 
                ? `${dateStr}${this.settings.dateSeparator}${fileName}`
                : `${fileName}${this.settings.dateSeparator}${dateStr}`;
        }

        return fileName;
    }

    startAutoImport() {
        console.log('Setting up auto-import with interval:', this.settings.importInterval);
        const interval = this.settings.importInterval * 60 * 1000; // convert minutes to milliseconds
        
        // Clear any existing interval
        if (this.importInterval) {
            window.clearInterval(this.importInterval);
        }
        
        // Set up new interval
        this.importInterval = window.setInterval(() => {
            this.importFromNotion();
            
            // Also sync local changes back to Notion if bidirectional sync is enabled
            if (this.settings.enableSync) {
                this.syncLocalChangesToNotion();
            }
        }, interval);
    }

    onunload() {
        console.log('Unloading Notion Importer plugin');
        window.clearInterval(this.importInterval);
        
        // Remove styles
        const styleEl = document.getElementById('notion-importer-styles');
        if (styleEl) {
            styleEl.remove();
        }
    }

    async syncLocalChangesToNotion() {
        console.log('Syncing local changes to Notion...');
        
        // Find all markdown files with Notion page IDs
        const files = this.app.vault.getMarkdownFiles();
        let syncCount = 0;
        
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                
                // Check if this is a Notion-imported file
                const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (!frontmatterMatch) continue;
                
                const frontmatter = frontmatterMatch[1];
                const pageIdMatch = frontmatter.match(/notion_page_id: (?:"([^"]+)"|([^\n]+))/);
                if (!pageIdMatch) continue;
                
                const pageId = pageIdMatch[1] || pageIdMatch[2];
                
                // Get local modification time
                const localStat = await this.app.vault.adapter.stat(file.path);
                if (!localStat) continue;
                
                // Try to get the Notion page's last edit time
                try {
                    const pageInfo = await this.notionClient.pages.retrieve({ page_id: pageId });
                    const notionLastEditTime = moment((pageInfo as PageObjectResponse).last_edited_time);
                    const localModTime = moment(localStat.mtime);
                    
                    // Only sync if local is newer than Notion
                    if (!localModTime.isAfter(notionLastEditTime)) {
                        console.log(`Skipping ${file.path} - Notion version is newer or same age`);
                        continue;
                    }
                } catch (error) {
                    console.log(`Couldn't retrieve Notion page info for ${file.path}:`, error);
                    // If we can't get Notion info, assume we should sync
                }
                
                // File needs syncing, so sync it
                await this.syncFileToNotion(file);
                syncCount++;
                
            } catch (error) {
                console.error(`Error syncing file ${file.path}:`, error);
            }
        }
        
        if (syncCount > 0) {
            new Notice(`Synced ${syncCount} files to Notion`);
        }
    }

    async handleFileModification(file: TFile) {
        // Debounce the sync to avoid too many API calls
        if ((file as any)._syncTimeout) {
            clearTimeout((file as any)._syncTimeout);
        }

        (file as any)._syncTimeout = setTimeout(async () => {
            await this.syncFileToNotion(file);
        }, 2000); // Wait 2 seconds after last modification
    }

    async handleFileRename(file: TFile, oldPath: string) {
        await this.syncFileToNotion(file, true);
    }

    async syncFileToNotion(file: TFile, isRename: boolean = false) {
        try {
            const content = await this.app.vault.read(file);
            
            // Extract frontmatter
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) {
                return; // No frontmatter, not a Notion-imported file
            }

            const frontmatter = frontmatterMatch[1];
            const pageIdMatch = frontmatter.match(/notion_page_id: (?:"([^"]+)"|([^\n]+))/);
            if (!pageIdMatch) {
                return; // No Notion page ID, not a Notion-imported file
            }

            const pageId = pageIdMatch[1] || pageIdMatch[2];
            console.log('Syncing changes to Notion page:', pageId);

            // Get local modification time
            const localStat = await this.app.vault.adapter.stat(file.path);
            const localModifiedTime = localStat ? moment(localStat.mtime) : moment();
            
            // Get the title from frontmatter or filename
            let title = file.basename;
            const titleMatch = frontmatter.match(/title: (?:"([^"]+)"|([^\n]+))/);
            if (titleMatch) {
                title = titleMatch[1] || titleMatch[2];
            }

            // Extract the content without frontmatter
            const markdownContent = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
            
            // Get Notion page's last edit time
            try {
                const pageInfo = await this.notionClient.pages.retrieve({ page_id: pageId });
                const notionLastEditTime = moment((pageInfo as PageObjectResponse).last_edited_time);
                
                // Check if the Notion version is newer based only on modification time
                if (notionLastEditTime.isAfter(localModifiedTime) && !isRename) {
                    console.log('Notion version is newer than local file');
                    
                    // We have a conflict based on dates - show resolution dialog
                    return new Promise<void>((resolve) => {
                        const modal = new SyncConflictModal(
                            this.app, 
                            (pageInfo as PageObjectResponse).last_edited_time,
                            localModifiedTime.format(),
                            this.getPageContent(pageId).then(notionContent => {
                                modal.setNotionContent(notionContent);
                            }),
                            markdownContent,
                            async (result) => {
                                if (result === 'notion') {
                                    // Use Notion version
                                    const notionContent = await this.getPageContent(pageId);
                                    await this.app.vault.modify(file, notionContent);
                                    new Notice(`Updated ${file.basename} from Notion (conflict resolved)`);
                                } else if (result === 'local') {
                                    // Continue with syncing the local version to Notion
                                    await this.syncFileToNotionImpl(file, pageId, title, markdownContent);
                                    new Notice(`Kept local version of ${file.basename} and synced to Notion`);
                                } else {
                                    // Cancel - do nothing
                                    new Notice('Sync cancelled');
                                }
                                resolve();
                            }
                        );
                        modal.open();
                    });
                }
            } catch (error) {
                console.log('Error retrieving Notion page:', error);
                // Continue with sync even if we couldn't check for conflicts
            }

            // If we get here, no conflicts were detected or it's a rename
            await this.syncFileToNotionImpl(file, pageId, title, markdownContent);

        } catch (error) {
            console.error('Error syncing to Notion:', error);
            new Notice(`Error syncing to Notion: ${error.message}`);
        }
    }

    // Helper method to actually perform the sync to Notion
    async syncFileToNotionImpl(file: TFile, pageId: string, title: string, markdownContent: string): Promise<void> {
        try {
            // Convert markdown content to Notion blocks
            const blocks = await this.markdownToBlocks(markdownContent);

            // Update the page title and content in Notion
            await this.notionClient.pages.update({
                page_id: pageId,
                properties: {
                    'title': {
                        title: [
                            {
                                text: {
                                    content: title
                                }
                            }
                        ]
                    }
                }
            });

            // First clear existing content to avoid duplication
            try {
                // Get existing blocks
                const existingBlocks = await this.notionClient.blocks.children.list({
                    block_id: pageId
                });
                
                // Delete each block
                for (const block of existingBlocks.results) {
                    await this.notionClient.blocks.delete({
                        block_id: block.id
                    });
                }
            } catch (error) {
                console.error('Error clearing existing blocks:', error);
            }

            // Add new content
            await this.notionClient.blocks.children.append({
                block_id: pageId,
                children: blocks
            });

            console.log('Successfully synced changes to Notion');
            new Notice('Successfully synced to Notion');
            
        } catch (error) {
            console.error('Error in syncFileToNotionImpl:', error);
            throw error;
        }
    }

    async markdownToBlocks(markdown: string): Promise<any[]> {
        const blocks: any[] = [];
        const lines = markdown.split('\n');
        let currentIndentLevel = 0;
        let blockStack: any[] = [];
        
        const getIndentLevel = (line: string): number => {
            const match = line.match(/^(\s*)/);
            return match ? Math.floor(match[1].length / 4) : 0;
        };
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const indentLevel = getIndentLevel(line);
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            const block = {
                object: 'block',
                type: '',
                has_children: false,
                children: []
            } as any;

            if (trimmedLine.startsWith('# ')) {
                block.type = 'heading_1';
                block.heading_1 = {
                    rich_text: [{ type: 'text', text: { content: trimmedLine.substring(2) } }]
                };
            } else if (trimmedLine.startsWith('## ')) {
                block.type = 'heading_2';
                block.heading_2 = {
                    rich_text: [{ type: 'text', text: { content: trimmedLine.substring(3) } }]
                };
            } else if (trimmedLine.startsWith('### ')) {
                block.type = 'heading_3';
                block.heading_3 = {
                    rich_text: [{ type: 'text', text: { content: trimmedLine.substring(4) } }]
                };
            } else if (trimmedLine.startsWith('- ')) {
                block.type = 'bulleted_list_item';
                block.bulleted_list_item = {
                    rich_text: [{ type: 'text', text: { content: trimmedLine.substring(2) } }]
                };
            } else if (trimmedLine.match(/^\d+\. /)) {
                block.type = 'numbered_list_item';
                block.numbered_list_item = {
                    rich_text: [{ type: 'text', text: { content: trimmedLine.substring(trimmedLine.indexOf(' ') + 1) } }]
                };
            } else if (trimmedLine.startsWith('> ')) {
                block.type = 'quote';
                block.quote = {
                    rich_text: [{ type: 'text', text: { content: trimmedLine.substring(2) } }]
                };
            } else if (trimmedLine.startsWith('```')) {
                block.type = 'code';
                let codeContent = '';
                const language = trimmedLine.substring(3);
                i++;
                while (i < lines.length && !lines[i].trim().startsWith('```')) {
                    codeContent += lines[i] + '\n';
                    i++;
                }
                block.code = {
                    language: language || 'plain text',
                    rich_text: [{ type: 'text', text: { content: codeContent.trim() } }]
                };
            } else {
                block.type = 'paragraph';
                block.paragraph = {
                    rich_text: [{ type: 'text', text: { content: trimmedLine } }]
                };
            }

            // Handle indentation
            if (indentLevel > currentIndentLevel) {
                // This is a child block
                if (blockStack.length > 0) {
                    const parent = blockStack[blockStack.length - 1];
                    parent.has_children = true;
                    if (!parent.children) parent.children = [];
                    parent.children.push(block);
                }
            } else {
                // This is a sibling or parent level block
                while (blockStack.length > indentLevel) {
                    blockStack.pop();
                }
                if (blockStack.length === 0) {
                    blocks.push(block);
                } else {
                    const parent = blockStack[blockStack.length - 1];
                    if (!parent.children) parent.children = [];
                    parent.children.push(block);
                }
            }

            blockStack[indentLevel] = block;
            currentIndentLevel = indentLevel;
        }

        return blocks;
    }

    // Add CSS styles for the diff view
    addStyles() {
        const styleEl = document.createElement('style');
        styleEl.id = 'notion-importer-styles';
        styleEl.textContent = `
            .diff-container {
                max-height: 400px;
                overflow-y: auto;
                margin: 10px 0;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
            }
            
            .diff-view {
                width: 100%;
                font-family: var(--font-monospace);
                font-size: 12px;
            }
            
            .diff-table {
                width: 100%;
                border-collapse: collapse;
            }
            
            .diff-table th {
                position: sticky;
                top: 0;
                background-color: var(--background-secondary);
                padding: 5px;
                text-align: left;
                border-bottom: 1px solid var(--background-modifier-border);
            }
            
            .diff-table td {
                padding: 2px 5px;
                white-space: pre-wrap;
                word-break: break-word;
                vertical-align: top;
                border-bottom: 1px solid var(--background-modifier-border);
            }
            
            .diff-table tr:hover td {
                background-color: var(--background-secondary);
            }
            
            .diff-removed {
                background-color: rgba(255, 100, 100, 0.2);
            }
            
            .diff-added {
                background-color: rgba(100, 255, 100, 0.2);
            }
            
            .diff-modified {
                background-color: rgba(255, 220, 100, 0.2);
            }
            
            .diff-truncated {
                text-align: center;
                font-style: italic;
                color: var(--text-muted);
            }
            
            .sync-buttons {
                display: flex;
                justify-content: space-between;
                margin-top: 15px;
            }
        `;
        document.head.appendChild(styleEl);
    }
}

class NotionImporterSettingTab extends PluginSettingTab {
    plugin: NotionImporterPlugin;
    previewEl: HTMLElement;

    constructor(app: App, plugin: NotionImporterPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        containerEl.createEl('h2', {text: 'Notion Importer Settings'});

        // Connection Settings
        containerEl.createEl('h3', {text: 'Connection Settings'});

        new Setting(containerEl)
            .setName('Notion Token')
            .setDesc('Your Notion integration token')
            .addText(text => text
                .setValue(this.plugin.settings.notionToken)
                .onChange(async (value) => {
                    this.plugin.settings.notionToken = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Database ID')
            .setDesc('The ID of your Notion database')
            .addText(text => text
                .setValue(this.plugin.settings.databaseId)
                .onChange(async (value) => {
                    this.plugin.settings.databaseId = value;
                    await this.plugin.saveSettings();
                }));

        // File Settings
        containerEl.createEl('h3', {text: 'File Settings'});

        // Add preview section at the top of file settings
        this.previewEl = containerEl.createEl('div', {
            cls: 'setting-item-description',
            text: 'Preview: '
        });
        this.updatePreview();

        new Setting(containerEl)
            .setName('Destination Folder')
            .setDesc('Folder where imported files will be saved')
            .addText((text: TextComponent) => {
                text
                    .setPlaceholder("Example: folder/subfolder")
                    .setValue(this.plugin.settings.destinationFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.destinationFolder = value;
                        await this.plugin.saveSettings();
                    });

                // Add folder suggestions with stored listener
                const folders = this.app.vault.getAllLoadedFiles()
                    .filter((f): f is TFolder => f instanceof TFolder)
                    .map(f => f.path);

                const focusListener = () => {
                    const modal = new FolderSuggestModal(this.app, text, folders);
                    modal.open();
                };
                
                // Store listener reference for removal
                (text.inputEl as any)._folderSuggestListener = focusListener;
                text.inputEl.addEventListener('focus', focusListener);
            });

        new Setting(containerEl)
            .setName('File Naming Pattern')
            .setDesc('Pattern for naming imported files (use {{title}} for the page title)')
            .addText(text => text
                .setValue(this.plugin.settings.fileNamingPattern)
                .onChange(async (value) => {
                    this.plugin.settings.fileNamingPattern = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Include Date in Filename')
            .setDesc('Add date to the filename')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeDateInFilename)
                .onChange(async (value) => {
                    this.plugin.settings.includeDateInFilename = value;
                    await this.plugin.saveSettings();
                    this.updatePreview();
                }));

        new Setting(containerEl)
            .setName('Date Source')
            .setDesc('Choose whether to use the Notion entry date or current date')
            .addDropdown(dropdown => dropdown
                .addOption('created', 'Notion entry date')
                .addOption('current', 'Current date')
                .setValue(this.plugin.settings.dateSource)
                .onChange(async (value: 'created' | 'current') => {
                    this.plugin.settings.dateSource = value;
                    await this.plugin.saveSettings();
                    this.updatePreview();
                }));

        new Setting(containerEl)
            .setName('Date Format')
            .setDesc('Format for the date (e.g., YYYY-MM-DD, YYYYMMDD, DD-MM-YYYY)')
            .addText(text => text
                .setValue(this.plugin.settings.dateFormat)
                .onChange(async (value) => {
                    this.plugin.settings.dateFormat = value;
                    await this.plugin.saveSettings();
                    this.updatePreview();
                }));

        new Setting(containerEl)
            .setName('Date Position')
            .setDesc('Where to place the date in the filename')
            .addDropdown(dropdown => dropdown
                .addOption('prefix', 'Before title')
                .addOption('suffix', 'After title')
                .setValue(this.plugin.settings.datePosition)
                .onChange(async (value: 'prefix' | 'suffix') => {
                    this.plugin.settings.datePosition = value;
                    await this.plugin.saveSettings();
                    this.updatePreview();
                }));

        new Setting(containerEl)
            .setName('Date Separator')
            .setDesc('Character(s) to use between date and title (e.g., --, _, )')
            .addText(text => text
                .setValue(this.plugin.settings.dateSeparator)
                .onChange(async (value) => {
                    this.plugin.settings.dateSeparator = value;
                    await this.plugin.saveSettings();
                    this.updatePreview();
                }));

        // Auto Import Settings
        containerEl.createEl('h3', {text: 'Auto Import Settings'});

        new Setting(containerEl)
            .setName('Auto Import')
            .setDesc('Automatically import on a schedule')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoImport)
                .onChange(async (value) => {
                    this.plugin.settings.autoImport = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.startAutoImport();
                    }
                }));

        new Setting(containerEl)
            .setName('Import Interval (minutes)')
            .setDesc('How often to check for updates when auto-import is enabled')
            .addText(text => text
                .setValue(String(this.plugin.settings.importInterval))
                .onChange(async (value) => {
                    this.plugin.settings.importInterval = Number(value);
                    await this.plugin.saveSettings();
                }));

        // Template Settings
        containerEl.createEl('h3', {text: 'Template Settings'});

        new Setting(containerEl)
            .setName('Use Template')
            .setDesc('Use an Obsidian template for imported notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.useTemplate = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Template Path')
            .setDesc('Path to the template file (e.g., templates/notion-import.md)')
            .addText((text: TextComponent) => {
                text
                    .setPlaceholder("Example: templates/notion-import.md")
                    .setValue(this.plugin.settings.templatePath)
                    .onChange(async (value) => {
                        this.plugin.settings.templatePath = value;
                        await this.plugin.saveSettings();
                    });

                // Add markdown file suggestions with stored listener
                const markdownFiles = this.app.vault.getMarkdownFiles()
                    .map(f => f.path);

                const focusListener = () => {
                    const modal = new FileSuggestModal(this.app, text, markdownFiles, this.plugin);
                    modal.open();
                };
                
                // Store listener reference for removal
                (text.inputEl as any)._fileSuggestListener = focusListener;
                text.inputEl.addEventListener('focus', focusListener);
            });

        // Add Sync Settings
        containerEl.createEl('h3', {text: 'Sync Settings'});

        new Setting(containerEl)
            .setName('Enable Bi-directional Sync')
            .setDesc('Sync changes from Obsidian back to Notion (requires restart to take effect)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableSync = value;
                    await this.plugin.saveSettings();
                }));
    }

    updatePreview() {
        const sampleTitle = "Sample Note Title";
        const sampleDate = "2024-03-27";
        const fileName = this.plugin.generateFileName(sampleTitle, sampleDate);
        this.previewEl.setText(`Preview: ${fileName}.md`);
    }
}

class FolderSuggestModal extends SuggestModal<string> {
    constructor(app: App, private textComponent: TextComponent, private folders: string[]) {
        super(app);
    }

    getSuggestions(query: string): string[] {
        const lowercaseQuery = query.toLowerCase();
        return this.folders
            .filter(f => f.toLowerCase().contains(lowercaseQuery))
            .sort((a, b) => a.length - b.length);
    }

    renderSuggestion(value: string, el: HTMLElement) {
        el.setText(value);
    }

    onChooseSuggestion(item: string, evt: MouseEvent | KeyboardEvent) {
        this.textComponent.setValue(item);
        // Remove focus event listener after selection
        const listener = (this.textComponent.inputEl as any)._folderSuggestListener;
        if (listener) {
            this.textComponent.inputEl.removeEventListener('focus', listener);
            delete (this.textComponent.inputEl as any)._folderSuggestListener;
        }
        this.close();
    }
}

class FileSuggestModal extends SuggestModal<string> {
    constructor(app: App, private textComponent: TextComponent, private files: string[], private plugin: NotionImporterPlugin) {
        super(app);
    }

    getSuggestions(query: string): string[] {
        const lowercaseQuery = query.toLowerCase();
        return this.files
            .filter(f => f.toLowerCase().contains(lowercaseQuery))
            .sort((a, b) => a.length - b.length);
    }

    renderSuggestion(value: string, el: HTMLElement) {
        el.setText(value);
    }

    async onChooseSuggestion(item: string, evt: MouseEvent | KeyboardEvent) {
        this.textComponent.setValue(item);
        this.plugin.settings.templatePath = item;
        await this.plugin.saveSettings();
        
        // Remove focus event listener after selection
        const listener = (this.textComponent.inputEl as any)._fileSuggestListener;
        if (listener) {
            this.textComponent.inputEl.removeEventListener('focus', listener);
            delete (this.textComponent.inputEl as any)._fileSuggestListener;
        }
        this.close();
    }
}

class SyncConflictModal extends Modal {
    private result: string = 'cancel';
    private callback: (result: string) => void;
    private notionContent: string = '';
    private localContent: string;
    private diffView: HTMLElement | null = null;
    private diffContainer: HTMLElement | null = null;

    constructor(
        app: App, 
        private notionTime: string, 
        private localTime: string, 
        notionContentPromise: Promise<void>,
        localContent: string,
        callback: (result: string) => void
    ) {
        super(app);
        this.callback = callback;
        this.localContent = localContent;
    }

    setNotionContent(content: string) {
        this.notionContent = content;
        this.updateDiffView();
    }

    updateDiffView() {
        if (this.diffContainer && this.notionContent) {
            if (this.diffView) {
                this.diffContainer.removeChild(this.diffView);
            }
            this.diffView = this.createDiffView(this.notionContent, this.localContent);
            this.diffContainer.appendChild(this.diffView);
        }
    }

    onOpen() {
        const {contentEl} = this;
        
        contentEl.createEl('h2', {text: 'Sync Conflict Detected'});
        
        contentEl.createEl('p', {text: 'There are conflicting modification timestamps between Notion and Obsidian:'});
        
        const infoDiv = contentEl.createDiv({cls: 'sync-info'});
        infoDiv.createEl('p', {text: `Notion last edited: ${moment(this.notionTime).format('YYYY-MM-DD HH:mm:ss')}`});
        infoDiv.createEl('p', {text: `Local last modified: ${moment(this.localTime).format('YYYY-MM-DD HH:mm:ss')}`});
        
        // Add diff view - will be populated when Notion content is available
        this.diffContainer = contentEl.createDiv({cls: 'diff-container'});
        if (this.notionContent) {
            this.diffView = this.createDiffView(this.notionContent, this.localContent);
            this.diffContainer.appendChild(this.diffView);
        } else {
            const loadingEl = document.createElement('p');
            loadingEl.textContent = 'Loading diff view...';
            this.diffContainer.appendChild(loadingEl);
        }
        
        const buttonDiv = contentEl.createDiv({cls: 'sync-buttons'});
        
        const keepNotionBtn = new ButtonComponent(buttonDiv)
            .setButtonText('Keep Notion Version')
            .onClick(() => {
                this.result = 'notion';
                this.close();
            });
            
        const keepLocalBtn = new ButtonComponent(buttonDiv)
            .setButtonText('Keep Local Version')
            .onClick(() => {
                this.result = 'local';
                this.close();
            });
            
        const cancelBtn = new ButtonComponent(buttonDiv)
            .setButtonText('Cancel')
            .onClick(() => {
                this.result = 'cancel';
                this.close();
            });
    }

    // Create a diff view between two text contents
    private createDiffView(oldContent: string, newContent: string): HTMLElement {
        const container = document.createElement('div');
        container.addClass('diff-view');
        
        // Split content into lines
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        
        // Create diff table
        const diffTable = document.createElement('table');
        diffTable.addClass('diff-table');
        
        // Add header
        const header = document.createElement('tr');
        const notionHeader = document.createElement('th');
        notionHeader.textContent = 'Notion Version';
        const obsidianHeader = document.createElement('th');
        obsidianHeader.textContent = 'Obsidian Version';
        header.appendChild(notionHeader);
        header.appendChild(obsidianHeader);
        diffTable.appendChild(header);
        
        // Create line index maps
        const diffMap = this.computeDiff(oldLines, newLines);
        
        // Maximum lines to display
        const maxDisplayLines = 500; // Limit to prevent UI slowdown
        let displayedLines = 0;
        
        // Add content rows
        for (const [oldIndex, newIndex] of diffMap) {
            if (displayedLines >= maxDisplayLines) break;
            
            const row = document.createElement('tr');
            
            const oldCell = document.createElement('td');
            const newCell = document.createElement('td');
            
            // Fill old content cell
            if (oldIndex !== null) {
                oldCell.textContent = oldLines[oldIndex];
                if (newIndex === null) {
                    oldCell.addClass('diff-removed');
                }
            }
            
            // Fill new content cell
            if (newIndex !== null) {
                newCell.textContent = newLines[newIndex];
                if (oldIndex === null) {
                    newCell.addClass('diff-added');
                }
            }
            
            // Highlight changes in modified lines
            if (oldIndex !== null && newIndex !== null && oldLines[oldIndex] !== newLines[newIndex]) {
                oldCell.addClass('diff-modified');
                newCell.addClass('diff-modified');
            }
            
            row.appendChild(oldCell);
            row.appendChild(newCell);
            diffTable.appendChild(row);
            
            displayedLines++;
        }
        
        // Add a note if content was truncated
        if (diffMap.length > maxDisplayLines) {
            const truncatedRow = document.createElement('tr');
            const truncatedCell = document.createElement('td');
            truncatedCell.colSpan = 2;
            truncatedCell.textContent = `(${diffMap.length - maxDisplayLines} more differences not shown)`;
            truncatedCell.addClass('diff-truncated');
            truncatedRow.appendChild(truncatedCell);
            diffTable.appendChild(truncatedRow);
        }
        
        container.appendChild(diffTable);
        return container;
    }
    
    // Compute a simplified diff between two arrays of lines
    // Returns an array of pairs [oldIndex, newIndex] where either can be null for added/removed lines
    private computeDiff(oldLines: string[], newLines: string[]): Array<[number | null, number | null]> {
        const result: Array<[number | null, number | null]> = [];
        
        // Build LCS (Longest Common Subsequence) matrix
        const matrix: number[][] = Array(oldLines.length + 1).fill(0).map(() => Array(newLines.length + 1).fill(0));
        
        for (let i = 1; i <= oldLines.length; i++) {
            for (let j = 1; j <= newLines.length; j++) {
                if (oldLines[i - 1] === newLines[j - 1]) {
                    matrix[i][j] = matrix[i - 1][j - 1] + 1;
                } else {
                    matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
                }
            }
        }
        
        // Backtrack to find the diff
        let i = oldLines.length;
        let j = newLines.length;
        
        const backtrack: Array<[number | null, number | null]> = [];
        
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
                backtrack.push([i - 1, j - 1]); // Match
                i--;
                j--;
            } else if (j > 0 && (i === 0 || matrix[i][j - 1] >= matrix[i - 1][j])) {
                backtrack.push([null, j - 1]); // Addition
                j--;
            } else if (i > 0) {
                backtrack.push([i - 1, null]); // Deletion
                i--;
            }
        }
        
        // Reverse and return
        return backtrack.reverse();
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
        this.callback(this.result);
    }
} 