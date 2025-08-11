import { Notice, TFile } from 'obsidian';
import type { Client } from '@notionhq/client';
import { withRetry, listAllChildBlocks } from '../utils';

export interface ExportContext {
  notion: Client;
  read: (file: TFile) => Promise<string>;
  modify: (file: TFile, content: string) => Promise<void>;
  updateLastEditedTimeInFile: (file: TFile, lastEdited: string) => Promise<void>;
  markdownToBlocks: (markdown: string) => any[];
}

export async function syncFileToNotion(ctx: ExportContext, file: TFile, pageId: string): Promise<boolean> {
  try {
    const content = await ctx.read(file);

    // Extract markdown body
    const parts = content.split(/^---\n([\s\S]*?)\n---\n/);
    const markdown = parts.length >= 3 ? parts[2] : content;

    // Update title
    const title = (content.match(/title:\s*["]?([^"'\n]+)["']?/) || [])[1] || file.basename;
    await withRetry(() => ctx.notion.pages.update({
      page_id: pageId,
      properties: {
        title: {
          title: [{ type: 'text', text: { content: title } }],
        },
      },
    }));

    // Clear existing blocks
    const allBlocks = await listAllChildBlocks(ctx.notion, pageId);
    const batchSize = 10;
    for (let i = 0; i < allBlocks.length; i += batchSize) {
      const batch = allBlocks.slice(i, i + batchSize);
      await Promise.all(batch.map(b => withRetry(() => ctx.notion.blocks.delete({ block_id: b.id }))
        .catch(err => console.error('Failed to delete block', b.id, err))));
      if (i + batchSize < allBlocks.length) await new Promise(r => setTimeout(r, 500));
    }

    // Append new blocks
    const blocks = ctx.markdownToBlocks(markdown);
    for (let i = 0; i < blocks.length; i += batchSize) {
      const batch = blocks.slice(i, i + batchSize);
      await withRetry(() => ctx.notion.blocks.children.append({ block_id: pageId, children: batch }));
      if (i + batchSize < blocks.length) await new Promise(r => setTimeout(r, 500));
    }

    // Update last edited
    const page = await withRetry(() => ctx.notion.pages.retrieve({ page_id: pageId }));
    if ('last_edited_time' in page) {
      await ctx.updateLastEditedTimeInFile(file, (page as any).last_edited_time as string);
    }

    new Notice(`Successfully synced ${file.basename} to Notion`);
    return true;
  } catch (error: any) {
    console.error('Error syncing to Notion:', error);
    new Notice(`Error syncing to Notion: ${error.message}`);
    return false;
  }
}
