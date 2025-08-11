import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TAbstractFile, TFile, TFolder, requestUrl, TextComponent, moment, ButtonComponent } from 'obsidian';
import { Client } from '@notionhq/client';
import { PageObjectResponse, BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { withRetry, listAllChildBlocks, getNotionPageIdFromContent, getLastEditedTimeFromContent, setLastEditedTimeInContent, parseTitleFromFrontmatter, pathIsWithinFolder, ConflictResolutionModal, markdownToBlocks } from './src/utils';
import { NotionImporterSettingTab } from './src/ui/settings';
import { importDatabase } from './src/sync/import';
import { syncFileToNotion as exportSyncFileToNotion } from './src/sync/export';

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
    bidirectionalSync: boolean; // Enable syncing changes back to Notion
    failedSyncs: { file: string; timestamp: number; error: string }[];
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
    bidirectionalSync: false,
    failedSyncs: []
}

export default class NotionImporterPlugin extends Plugin {
    settings: NotionImporterSettings;
    notionClient: Client;
    importInterval: number;
    debounceTimeouts: Record<string, NodeJS.Timeout> = {};
    private isImportRunning: boolean = false;
    private isTwoWaySyncRunning: boolean = false;
    private syncingFiles: Set<string> = new Set();

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
        
        // Add command for bidirectional sync
        this.addCommand({
            id: 'notion-importer-sync',
            name: 'Sync Local Changes to Notion',
            callback: () => {
                if (this.settings.bidirectionalSync) {
                    this.syncLocalChangesToNotion();
                } else {
                    new Notice('Bidirectional sync is not enabled in settings');
                }
            }
        });
        // Add combined two-way sync command
        this.addCommand({
            id: 'notion-importer-sync-bidirectional',
            name: 'Sync Notion ↔ Obsidian',
            callback: async () => {
                if (!this.settings.bidirectionalSync) {
                    new Notice('Bidirectional sync is not enabled in settings');
                    return;
                }
                if (this.isTwoWaySyncRunning) {
                    console.log('Two-way sync already running, skipping');
                    return;
                }
                this.isTwoWaySyncRunning = true;
                try {
                    await this.importFromNotion();
                    await this.syncLocalChangesToNotion();
                } finally {
                    this.isTwoWaySyncRunning = false;
                }
            }
        });

        // Register file modified event for real-time sync
        this.registerEvent(
            this.app.vault.on('modify', async (file: TAbstractFile) => {
                // Only process markdown files
                if (!(file instanceof TFile) || file.extension !== 'md') {
                    return;
                }
                
                // Skip if bidirectional sync is disabled
                if (!this.settings.bidirectionalSync) {
                    return;
                }
                // Only sync files inside the configured destination folder
                if (!pathIsWithinFolder(file.path, this.settings.destinationFolder)) {
                    return;
                }
                
                // Check if the file has a Notion page ID
                const pageId = await this.getNotionPageIdFromFile(file as TFile);
                if (!pageId) {
                    return;
                }
                
                console.log(`File modified with Notion page ID: ${file.path}`);
                
                // Use debouncing to avoid multiple syncs when a file is modified rapidly
                if (this.debounceTimeouts && this.debounceTimeouts[file.path]) {
                    clearTimeout(this.debounceTimeouts[file.path]);
                }
                
                // Initialize debounce timeouts object if it doesn't exist
                this.debounceTimeouts = this.debounceTimeouts || {};
                
                // Set a debounce timeout to sync the file after 2 seconds of inactivity
                this.debounceTimeouts[file.path] = setTimeout(async () => {
                    console.log(`Syncing modified file to Notion: ${file.path}`);
                    await this.syncFileToNotion(file as TFile);
                    delete this.debounceTimeouts[file.path];
                }, 2000);
            })
        );

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
                
                // Log response status for debugging
                console.log(`Response status: ${response.status}`);
                
                if (response.status >= 400) {
                    console.error('Error response:', {
                        status: response.status,
                        statusText: response.status,
                        body: response.json
                    });
                    
                    // Provide more helpful error messages based on status code
                    let errorMessage = `Notion API Error: ${response.status}`;
                    if (response.status === 400) {
                        errorMessage = 'Bad Request (400): Invalid data format sent to Notion API';
                    } else if (response.status === 401) {
                        errorMessage = 'Unauthorized (401): Please check your Notion token';
                    } else if (response.status === 404) {
                        errorMessage = 'Not Found (404): Resource not found, check your page/database IDs';
                    } else if (response.status === 429) {
                        errorMessage = 'Rate Limited (429): Too many requests to Notion API';
                    }
                    
                    throw new Error(errorMessage);
                }
                
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
                
                // Enhance error with more details
                if (error.response) {
                    error.message = `${error.message} - Status: ${error.status}, Response: ${JSON.stringify(error.response)}`;
                }
                
                throw error;
            }
        };

        this.notionClient = new Client({
            auth: this.settings.notionToken,
            fetch: customFetch as any
        });

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

    async getNotionPageIdFromFile(file: TFile): Promise<string | null> {
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];
            const pageIdMatch = frontmatter.match(/notion_page_id:\s*["']?([^"'\n]+)["']?/);
            if (pageIdMatch && pageIdMatch[1]) {
                return pageIdMatch[1];
            }
        }
        return null;
    }

    async getLastEditedTimeFromFile(file: TFile): Promise<string | null> {
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];
            const lastEditedMatch = frontmatter.match(/last_edited_time:\s*["']?([^"'\n]+)["']?/);
            if (lastEditedMatch && lastEditedMatch[1]) {
                return lastEditedMatch[1];
            }
        }
        return null;
    }

    async updateLastEditedTimeInFile(file: TFile, lastEditedTime: string): Promise<void> {
        const content = await this.app.vault.read(file);
        const updatedContent = content.replace(
            /last_edited_time:\s*["']?([^"'\n]+)["']?/,
            `last_edited_time: "${lastEditedTime}"`
        );
        await this.app.vault.modify(file, updatedContent);
    }

    async syncFileToNotion(file: TFile): Promise<boolean> {
        try {
            console.log(`Syncing file to Notion: ${file.path}`);
            if (this.syncingFiles.has(file.path)) {
                console.log('Sync already in progress for file, skipping:', file.path);
                return false;
            }
            this.syncingFiles.add(file.path);
            
            // Get the Notion page ID from frontmatter
            const pageId = await this.getNotionPageIdFromFile(file);
            if (!pageId) {
                console.log(`No Notion page ID found in file: ${file.path}`);
                this.syncingFiles.delete(file.path);
                return false;
            }
            
            console.log(`Found Notion page ID: ${pageId} for file: ${file.path}`);
            
            // Get the last edited time from the frontmatter
            const localLastEditedTime = await this.getLastEditedTimeFromFile(file);
            
            // Check if the page still exists in Notion
            try {
                const page = await withRetry(() => this.notionClient.pages.retrieve({ page_id: pageId }));
                
                // Check for conflicts - compare local last edited time with Notion's last edited time
                if (localLastEditedTime && 'last_edited_time' in page) {
                    const notionLastEditedTime = page.last_edited_time;
                    
                    console.log(`Comparing edit times - Local: ${localLastEditedTime}, Notion: ${notionLastEditedTime}`);
                    
                    // If Notion version is newer, we have a conflict
                    if (new Date(notionLastEditedTime) > new Date(localLastEditedTime)) {
                        console.log(`Conflict detected: Notion version is newer than local version`);
                        // Ask user to resolve conflict
                        const choice = await new Promise<'keep-local' | 'keep-notion' | 'cancel'>(resolve => {
                            const modal = new ConflictResolutionModal(this.app, resolve);
                            modal.open();
                        });
                        if (choice === 'cancel') {
                            this.syncingFiles.delete(file.path);
                            return false;
                        } else if (choice === 'keep-notion') {
                            // Overwrite local from Notion
                            const content = await this.getPageContent(pageId);
                            await this.app.vault.modify(file, content);
                            this.syncingFiles.delete(file.path);
                            return true;
                        }
                    }
                }
                
                // Update the page in Notion
                const ok = await this.syncFileToNotionImpl(file, pageId);
                this.syncingFiles.delete(file.path);
                return ok;
                
            } catch (error: any) {
                console.error(`Error retrieving Notion page: ${error.message}`);
                if (error.status === 404) {
                    new Notice(`Notion page not found for ${file.basename}. It may have been deleted.`);
                } else {
                    new Notice(`Error syncing to Notion: ${error.message}`);
                }
                this.syncingFiles.delete(file.path);
                return false;
            }
        } catch (error: any) {
            console.error(`Error syncing file to Notion: ${error.message}`);
            new Notice(`Error syncing ${file.basename} to Notion: ${error.message}`);
            this.syncingFiles.delete(file.path);
            return false;
        }
    }
    
    async syncFileToNotionImpl(file: TFile, pageId: string): Promise<boolean> {
        return await exportSyncFileToNotion({
            notion: this.notionClient,
            read: (f: TFile) => this.app.vault.read(f),
            modify: (f: TFile, c: string) => this.app.vault.modify(f, c),
            updateLastEditedTimeInFile: (f: TFile, t: string) => this.updateLastEditedTimeInFile(f, t),
            markdownToBlocks: markdownToBlocks,
        }, file, pageId);
    }

    async syncLocalChangesToNotion() {
        if (!this.settings.bidirectionalSync) {
            return;
        }
        
        try {
            console.log("Starting sync of local changes to Notion");
            
            // Get all markdown files
            const files = this.app.vault.getMarkdownFiles();
            let syncedCount = 0;
            
            for (const file of files) {
                // Only consider files within the destination folder
                if (!pathIsWithinFolder(file.path, this.settings.destinationFolder)) {
                    continue;
                }
                // Skip files without a Notion page ID
                const pageId = await this.getNotionPageIdFromFile(file);
                if (!pageId) {
                    continue;
                }
                
                // Check if the local file is newer than Notion
                const fileModifiedTime = file.stat.mtime;
                const localLastEditedTime = await this.getLastEditedTimeFromFile(file);
                
                if (localLastEditedTime) {
                    const notionLastEditTime = new Date(localLastEditedTime);
                    
                    // If local file is newer than the last known Notion edit time, sync to Notion
                    if (fileModifiedTime > notionLastEditTime.getTime()) {
                        console.log(`Local file ${file.path} is newer, syncing to Notion`);
                        const success = await this.syncFileToNotion(file);
                        
                        if (success) {
                            syncedCount++;
                        }
                    }
                }
            }
            
            if (syncedCount > 0) {
                new Notice(`Synced ${syncedCount} files to Notion`);
            }
        } catch (error: any) {
            console.error("Error syncing local changes to Notion:", error);
            new Notice(`Error syncing to Notion: ${error.message}`);
        }
    }

    async importFromNotion() {
        try {
            if (this.isImportRunning) {
                console.log('Import already running, skipping');
                return;
            }
            this.isImportRunning = true;
            // Validate settings
            if (!this.settings.notionToken) {
                new Notice('Please set your Notion integration token in settings');
                this.isImportRunning = false;
                return;
            }
            if (!this.settings.databaseId) {
                new Notice('Please set your Notion database ID in settings');
                this.isImportRunning = false;
                return;
            }

            // Ensure destination folder exists
            await this.ensureFolderExists(this.settings.destinationFolder);

            // Test database access
            try {
                console.log('Testing database access with ID:', this.settings.databaseId);
                await withRetry(() => this.notionClient.databases.retrieve({
                    database_id: this.settings.databaseId,
                }));
            } catch (error: any) {
                console.error('Database access error:', error);
                if (error.status === 404) {
                    new Notice(`Database not found (404). ID: ${this.settings.databaseId}. Please check your database ID and make sure the integration has access to it.`);
                } else if (error.status === 401) {
                    new Notice('Invalid integration token (401). Please check your Notion integration token.');
                } else {
                    new Notice(`Error accessing database: ${error.message}`);
                }
                this.isImportRunning = false;
                return;
            }

            const count = await importDatabase({
                notion: this.notionClient,
                destinationFolder: this.settings.destinationFolder,
                appVault: {
                    ensureFolderExists: (p: string) => this.ensureFolderExists(p),
                    findFileByNotionPageId: (pageId: string) => this.findFileByNotionPageId(pageId),
                    generateFileName: (title: string, created?: string) => this.generateFileName(title, created),
                    read: (file: TFile) => this.app.vault.read(file),
                    create: (path: string, content: string) => this.app.vault.create(path, content),
                    modify: (file: TFile, content: string) => this.app.vault.modify(file, content),
                },
                getPageContent: (pageId: string) => this.getPageContent(pageId),
            }, this.settings.databaseId);
            if (count > 0) new Notice(`Imported/updated ${count} notes from Notion`);
            this.isImportRunning = false;
        } catch (error: any) {
            console.error('Error importing from Notion:', error);
            new Notice(`Error importing from Notion: ${error.message}`);
            this.isImportRunning = false;
        }
    }

    async getPageContent(pageId: string): Promise<string> {
        console.log('Fetching content for page:', pageId);
        const blocks = await withRetry(() => this.notionClient.blocks.children.list({
            block_id: pageId,
            page_size: 100
        }));

        let allBlocks = [...blocks.results];
        let nextCursor = blocks.next_cursor;

        // Fetch all blocks using pagination
        while (nextCursor) {
            const moreBlocks = await withRetry(() => this.notionClient.blocks.children.list({
                block_id: pageId,
                start_cursor: nextCursor,
                page_size: 100
            }));
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
        const page = await withRetry(() => this.notionClient.pages.retrieve({ page_id: pageId }));
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
                const childBlocks = await listAllChildBlocks(this.notionClient, block.id);
                children = childBlocks;
            }
            
            const markdown = await this.blockToMarkdown(block as BlockObjectResponse, children);
            if (!markdown) continue;

            // Handle list continuity and indentation
            if (['bulleted_list_item', 'numbered_list_item', 'to_do'].includes((block as any).type)) {
                if (currentListType !== (block as any).type) {
                    if (currentListType) formattedContent += '\n';
                    currentListType = (block as any).type;
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
                    const nestedBlocks = await listAllChildBlocks(this.notionClient, child.id);
                    nestedChildren = nestedBlocks;
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
        // Clear any existing interval
        if (this.importInterval) {
            window.clearInterval(this.importInterval);
        }
        
        // Set new interval
        const minutes = this.settings.importInterval;
        console.log(`Setting up auto-import every ${minutes} minutes`);
        
        this.importInterval = window.setInterval(() => {
            console.log('Auto-importing from Notion');
            if (!this.isImportRunning && !this.isTwoWaySyncRunning) {
                this.importFromNotion();
            } else {
                console.log('Skipping auto-import; another sync is running');
            }
            
            // Also sync local changes to Notion if bidirectional sync is enabled
            if (this.settings.bidirectionalSync) {
                console.log('Syncing local changes to Notion');
                if (!this.isTwoWaySyncRunning) {
                    this.syncLocalChangesToNotion();
                } else {
                    console.log('Skipping local sync; another sync is running');
                }
            }
        }, minutes * 60 * 1000);
    }

    async onunload() {
        console.log('Unloading Notion Importer plugin');
        
        // Clear any auto-import interval
        if (this.importInterval) {
            window.clearInterval(this.importInterval);
        }
        
        // Clear any pending debounce timeouts
        if (this.debounceTimeouts) {
            Object.values(this.debounceTimeouts).forEach(timeout => {
                clearTimeout(timeout);
            });
        }
        
        // Remove styles
        const styleEl = document.getElementById('notion-importer-styles');
        if (styleEl) {
            styleEl.remove();
        }
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

// Settings UI moved to src/ui/settings.ts 