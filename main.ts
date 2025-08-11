import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, SuggestModal, TAbstractFile, TFile, TFolder, requestUrl, TextComponent, moment, ButtonComponent } from 'obsidian';
import { Client } from '@notionhq/client';
import { PageObjectResponse, BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { withRetry, listAllChildBlocks, getNotionPageIdFromContent, getLastEditedTimeFromContent, setLastEditedTimeInContent, parseTitleFromFrontmatter, pathIsWithinFolder, ConflictResolutionModal } from './src/utils';

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
        try {
            console.log(`Starting sync implementation for ${file.path} to Notion page ${pageId}`);
            
            // Read the file content
            const content = await this.app.vault.read(file);
            
            // Split content into frontmatter and markdown
            const parts = content.split(/^---\n([\s\S]*?)\n---\n/);
            let markdown = '';
            
            if (parts.length >= 3) {
                // If frontmatter exists, markdown is after the frontmatter
                markdown = parts[2];
            } else {
                // No frontmatter, whole content is markdown
                markdown = content;
            }
            
            // Extract title from frontmatter
            let title = parseTitleFromFrontmatter(content, file.basename);
            
            // Update the page title
            await withRetry(() => this.notionClient.pages.update({
                page_id: pageId,
                properties: {
                    title: {
                        title: [
                            {
                                type: "text",
                                text: {
                                    content: title
                                }
                            }
                        ]
                    }
                }
            }));
            
            console.log(`Updated title for page ${pageId} to: ${title}`);
            
            // Clear existing blocks
            try {
                // First get all existing blocks (paginated)
                const allBlocks = await listAllChildBlocks(this.notionClient, pageId);
                // Delete blocks in batches to avoid rate limits
                const batchSize = 10;
                const blockIds = allBlocks.map(block => block.id);
                
                for (let i = 0; i < blockIds.length; i += batchSize) {
                    const batch = blockIds.slice(i, i + batchSize);
                    console.log(`Deleting batch of ${batch.length} blocks`);
                    
                    // Delete blocks in parallel
                    await Promise.all(batch.map(blockId =>
                        withRetry(() => this.notionClient.blocks.delete({ block_id: blockId }))
                            .catch(error => {
                                console.error(`Error deleting block ${blockId}: ${error.message}`);
                            })
                    ));
                    
                    // Wait a bit to avoid rate limits
                    if (i + batchSize < blockIds.length) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                
                console.log(`Cleared ${blockIds.length} blocks from page ${pageId}`);
            } catch (error: any) {
                console.error(`Error clearing blocks: ${error.message}`);
                new Notice(`Error clearing content: ${error.message}`);
                return false;
            }
            
            // Convert markdown to Notion blocks
            // This is a simplified version - you'd need a proper markdown parser
            const lines = markdown.trim().split('\n');
            const blocks: any[] = []; // Use any[] to avoid type errors with BlockObjectRequest
            
            let currentParagraph = '';
            
            for (const line of lines) {
                if (line.trim() === '') {
                    // Empty line ends a paragraph
                    if (currentParagraph !== '') {
                        blocks.push({
                            object: 'block',
                            type: 'paragraph',
                            paragraph: {
                                rich_text: [{
                                    type: 'text',
                                    text: {
                                        content: currentParagraph
                                    }
                                }]
                            }
                        });
                        currentParagraph = '';
                    }
                } else if (line.startsWith('# ')) {
                    // Handle heading 1
                    blocks.push({
                        object: 'block',
                        type: 'heading_1',
                        heading_1: {
                            rich_text: [{
                                type: 'text',
                                text: {
                                    content: line.slice(2)
                                }
                            }]
                        }
                    });
                } else if (line.startsWith('## ')) {
                    // Handle heading 2
                    blocks.push({
                        object: 'block',
                        type: 'heading_2',
                        heading_2: {
                            rich_text: [{
                                type: 'text',
                                text: {
                                    content: line.slice(3)
                                }
                            }]
                        }
                    });
                } else if (line.startsWith('### ')) {
                    // Handle heading 3
                    blocks.push({
                        object: 'block',
                        type: 'heading_3',
                        heading_3: {
                            rich_text: [{
                                type: 'text',
                                text: {
                                    content: line.slice(4)
                                }
                            }]
                        }
                    });
                } else if (line.startsWith('- ')) {
                    // Handle bullet lists
                    blocks.push({
                        object: 'block',
                        type: 'bulleted_list_item',
                        bulleted_list_item: {
                            rich_text: [{
                                type: 'text',
                                text: {
                                    content: line.slice(2)
                                }
                            }]
                        }
                    });
                } else {
                    // Add to current paragraph
                    if (currentParagraph !== '') {
                        currentParagraph += '\n';
                    }
                    currentParagraph += line;
                }
            }
            
            // Add the last paragraph if not empty
            if (currentParagraph !== '') {
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{
                            type: 'text',
                            text: {
                                content: currentParagraph
                            }
                        }]
                    }
                });
            }
            
            // Add blocks in batches to avoid rate limits
            const blockBatchSize = 10;
            
            for (let i = 0; i < blocks.length; i += blockBatchSize) {
                const batch = blocks.slice(i, i + blockBatchSize);
                console.log(`Adding batch of ${batch.length} blocks to page ${pageId}`);
                
                await withRetry(() => this.notionClient.blocks.children.append({
                    block_id: pageId,
                    children: batch
                }));
                
                // Wait a bit to avoid rate limits
                if (i + blockBatchSize < blocks.length) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            // Update the last edited time in the frontmatter
            const page = await withRetry(() => this.notionClient.pages.retrieve({ page_id: pageId }));
            if ('last_edited_time' in page) {
                await this.updateLastEditedTimeInFile(file, page.last_edited_time);
            }
            
            console.log(`Successfully synced ${file.path} to Notion page ${pageId}`);
            new Notice(`Successfully synced ${file.basename} to Notion`);
            return true;
        } catch (error: any) {
            console.error(`Error in sync implementation: ${error.message}`);
            new Notice(`Error syncing to Notion: ${error.message}`);
            return false;
        }
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

            console.log('Querying database...');
            const response = await withRetry(() => this.notionClient.databases.query({
                database_id: this.settings.databaseId,
            }));

            console.log('Database query response:', response);

            if (!response.results || response.results.length === 0) {
                new Notice('No entries found in the database');
                this.isImportRunning = false;
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
                            // Compare edit times and update if Notion is newer
                            const localContent = await this.app.vault.read(existingFile);
                            const localLastEdited = getLastEditedTimeFromContent(localContent);
                            const notionLastEdited = (page as any).last_edited_time as string | undefined;
                            if (notionLastEdited && localLastEdited && new Date(notionLastEdited) > new Date(localLastEdited)) {
                                console.log('Notion page is newer, updating local file');
                                await this.app.vault.modify(existingFile, content);
                                new Notice(`Updated ${existingFile.basename} from Notion`);
                            } else {
                                console.log('Local file is up to date - skipping');
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
                            // Don't show error notice for file already exists error
                            if (error.message && error.message.includes('already exists')) {
                                console.log(`File ${fileName} already exists - skipping`);
                            } else {
                                new Notice(`Error creating file ${fileName}: ${error.message}`);
                            }
                        }
                    } else {
                        console.log('Skipping page - no title property found');
                        console.log('Available properties:', page.properties);
                    }
                } else {
                    console.log('Skipping page - no properties found');
                }
            }
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

        // Synchronization Settings
        containerEl.createEl('h3', {text: 'Synchronization Settings'});

        new Setting(containerEl)
            .setName('Bidirectional Sync')
            .setDesc('Enable syncing local changes back to Notion (changes in Obsidian will be reflected in Notion)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.bidirectionalSync)
                .onChange(async (value) => {
                    this.plugin.settings.bidirectionalSync = value;
                    await this.plugin.saveSettings();
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
            .filter(f => f.toLowerCase().includes(lowercaseQuery))
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
            .filter(f => f.toLowerCase().includes(lowercaseQuery))
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