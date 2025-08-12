import { Client } from '@notionhq/client';
import { TFile } from 'obsidian';
import { NotionRateLimiter } from './rate-limiter';
import { ContentDiffer } from './content-diff';
import { withRetry, markdownToBlocks } from './utils';

interface SyncOperation {
  type: 'import' | 'export';
  file?: TFile;
  pageId: string;
  priority: number;
  retryCount: number;
}

interface OptimizedSyncContext {
  notion: Client;
  read: (file: TFile) => Promise<string>;
  modify: (file: TFile, content: string) => Promise<void>;
  updateLastEditedTimeInFile: (file: TFile, time: string) => Promise<void>;
  getPageContent: (pageId: string) => Promise<string>;
}

export class OptimizedSyncManager {
  private rateLimiter: NotionRateLimiter;
  private contentDiffer: ContentDiffer;
  private syncQueue: SyncOperation[] = [];
  private activeSyncs = new Set<string>();
  private processing = false;

  constructor(private ctx: OptimizedSyncContext) {
    this.rateLimiter = new NotionRateLimiter({
      requestsPerSecond: 2.5,
      burstSize: 5,
      adaptiveBackoff: true
    });
    this.contentDiffer = new ContentDiffer(ctx.notion);
  }

  async queueExportSync(file: TFile, pageId: string, priority: number = 0): Promise<boolean> {
    if (this.activeSyncs.has(file.path)) {
      console.log(`Sync already active for ${file.path}, skipping`);
      return false;
    }

    return new Promise((resolve, reject) => {
      this.syncQueue.push({
        type: 'export',
        file,
        pageId,
        priority,
        retryCount: 0
      });

      this.syncQueue.sort((a, b) => b.priority - a.priority);
      
      this.processQueue().then(() => {
        resolve(true);
      }).catch(reject);
    });
  }

  async optimizedExportSync(file: TFile, pageId: string): Promise<boolean> {
    if (this.activeSyncs.has(file.path)) {
      return false;
    }

    this.activeSyncs.add(file.path);
    
    try {
      console.log(`Starting optimized sync for ${file.path}`);
      
      // Read file content
      const content = await this.ctx.read(file);
      
      // Extract markdown body and title
      const parts = content.split(/^---\n([\s\S]*?)\n---\n/);
      const markdown = parts.length >= 3 ? parts[2] : content;
      const title = (content.match(/title:\s*["]?([^"'\n]+)["']?/) || [])[1] || file.basename;

      // Check if page exists and get current state
      const pageExists = await this.rateLimiter.execute(async () => {
        try {
          await this.ctx.notion.pages.retrieve({ page_id: pageId });
          return true;
        } catch (error: any) {
          if (error.status === 404) {
            return false;
          }
          throw error;
        }
      }, 1);

      if (!pageExists) {
        console.log(`Page ${pageId} not found, cannot sync`);
        return false;
      }

      // Diff content to see what actually needs updating
      const diff = await this.contentDiffer.diffPageContent(pageId, markdown, title);
      
      if (!diff.hasChanges) {
        console.log(`No changes detected for ${file.path}, skipping sync`);
        return true;
      }

      console.log(`Changes detected for ${file.path}:`, {
        titleChanged: diff.titleChanged,
        blockChanges: diff.diffs.filter(d => d.type !== 'unchanged').length
      });

      // Update title if changed
      if (diff.titleChanged && diff.newTitle) {
        await this.rateLimiter.execute(async () => {
          return this.ctx.notion.pages.update({
            page_id: pageId,
            properties: {
              title: {
                title: [{ type: 'text', text: { content: diff.newTitle! } }],
              },
            },
          });
        }, 2);
      }

      // Apply block changes efficiently
      await this.applyBlockChanges(pageId, diff.diffs);

      // Update last edited time
      const page = await this.rateLimiter.execute(() => 
        this.ctx.notion.pages.retrieve({ page_id: pageId }), 1
      );
      
      if ('last_edited_time' in page) {
        await this.ctx.updateLastEditedTimeInFile(file, (page as any).last_edited_time as string);
      }

      console.log(`Successfully synced ${file.path} with optimizations`);
      return true;

    } catch (error: any) {
      console.error(`Error in optimized sync for ${file.path}:`, error);
      
      // Fallback to traditional sync if optimization fails
      if (error.message?.includes('diff') || error.message?.includes('optimization')) {
        console.log(`Falling back to traditional sync for ${file.path}`);
        return this.fallbackTraditionalSync(file, pageId);
      }
      
      throw error;
    } finally {
      this.activeSyncs.delete(file.path);
    }
  }

  private async applyBlockChanges(pageId: string, diffs: any[]): Promise<void> {
    const deletions = diffs.filter(d => d.type === 'delete');
    const updates = diffs.filter(d => d.type === 'update');
    const creations = diffs.filter(d => d.type === 'create');

    // Process deletions first
    for (const diff of deletions) {
      if (diff.blockId) {
        await this.rateLimiter.execute(async () => {
          return this.ctx.notion.blocks.delete({ block_id: diff.blockId });
        }, 1);
      }
    }

    // Process updates (delete + recreate for now, could be optimized further)
    for (const diff of updates) {
      if (diff.blockId) {
        await this.rateLimiter.execute(async () => {
          return this.ctx.notion.blocks.delete({ block_id: diff.blockId });
        }, 1);
      }
    }

    // Batch create new blocks (updates + creations)
    const blocksToCreate = [...updates, ...creations]
      .sort((a, b) => a.position - b.position)
      .map(d => d.content);

    if (blocksToCreate.length > 0) {
      const batchSize = 10;
      for (let i = 0; i < blocksToCreate.length; i += batchSize) {
        const batch = blocksToCreate.slice(i, i + batchSize);
        await this.rateLimiter.execute(async () => {
          return this.ctx.notion.blocks.children.append({ 
            block_id: pageId, 
            children: batch 
          });
        }, 1);
      }
    }
  }

  private async fallbackTraditionalSync(file: TFile, pageId: string): Promise<boolean> {
    // Traditional sync implementation as fallback
    const content = await this.ctx.read(file);
    const parts = content.split(/^---\n([\s\S]*?)\n---\n/);
    const markdown = parts.length >= 3 ? parts[2] : content;
    const title = (content.match(/title:\s*["]?([^"'\n]+)["']?/) || [])[1] || file.basename;

    // Update title
    await this.rateLimiter.execute(async () => {
      return this.ctx.notion.pages.update({
        page_id: pageId,
        properties: {
          title: {
            title: [{ type: 'text', text: { content: title } }],
          },
        },
      });
    }, 2);

    // Get all blocks and delete them
    const allBlocks = await this.rateLimiter.execute(async () => {
      const response = await this.ctx.notion.blocks.children.list({
        block_id: pageId,
        page_size: 100
      });
      return response.results;
    }, 1);

    // Delete existing blocks
    for (const block of allBlocks) {
      await this.rateLimiter.execute(async () => {
        return this.ctx.notion.blocks.delete({ block_id: (block as any).id });
      }, 1);
    }

    // Create new blocks
    const blocks = markdownToBlocks(markdown);
    const batchSize = 10;
    for (let i = 0; i < blocks.length; i += batchSize) {
      const batch = blocks.slice(i, i + batchSize);
      await this.rateLimiter.execute(async () => {
        return this.ctx.notion.blocks.children.append({ block_id: pageId, children: batch });
      }, 1);
    }

    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.syncQueue.length > 0) {
      const operation = this.syncQueue.shift()!;
      
      try {
        if (operation.type === 'export' && operation.file) {
          await this.optimizedExportSync(operation.file, operation.pageId);
        }
      } catch (error: any) {
        console.error(`Sync operation failed:`, error);
        
        // Retry logic
        if (operation.retryCount < 3 && (error.status === 429 || error.status >= 500)) {
          operation.retryCount++;
          operation.priority -= 1; // Lower priority for retries
          this.syncQueue.push(operation);
          this.syncQueue.sort((a, b) => b.priority - a.priority);
        }
      }
    }

    this.processing = false;
  }

  getStatus(): { 
    queueLength: number; 
    activeSyncs: number; 
    rateLimiterStatus: ReturnType<NotionRateLimiter['getQueueStatus']>;
  } {
    return {
      queueLength: this.syncQueue.length,
      activeSyncs: this.activeSyncs.size,
      rateLimiterStatus: this.rateLimiter.getQueueStatus()
    };
  }
}
