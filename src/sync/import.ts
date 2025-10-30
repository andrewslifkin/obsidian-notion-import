import { Notice, TFile } from 'obsidian';
import type { Client } from '@notionhq/client';
import type { PageObjectResponse, BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { withRetry, listAllChildBlocks, replaceFrontmatterField } from '../utils';

export interface ImportContext {
  notion: Client;
  destinationFolder: string;
  appVault: {
    ensureFolderExists: (path: string) => Promise<void>;
    findFileByNotionPageId: (pageId: string) => Promise<TFile | null>;
    generateFileName: (title: string, created?: string) => string;
    read: (file: TFile) => Promise<string>;
    create: (path: string, content: string) => Promise<void>;
    modify: (file: TFile, content: string) => Promise<void>;
  };
  getPageContent: (pageId: string) => Promise<string>;
  execute?: <T>(fn: () => Promise<T>, priority?: number) => Promise<T>;
}

export async function importDatabase(ctx: ImportContext, databaseId: string): Promise<number> {
  await ctx.appVault.ensureFolderExists(ctx.destinationFolder);

  const exec = async <T>(fn: () => Promise<T>, priority: number = 1): Promise<T> => {
    if (ctx.execute) return ctx.execute(fn, priority);
    return withRetry(fn);
  };

  await exec(() => ctx.notion.databases.retrieve({ database_id: databaseId }), 2);

  // Fetch all pages with pagination
  let allResults: any[] = [];
  let startCursor: string | undefined = undefined;
  do {
    const page = await exec(() => ctx.notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: startCursor,
    }), 1);
    allResults = allResults.concat(page.results || []);
    startCursor = (page as any).next_cursor ?? undefined;
  } while (startCursor);

  if (allResults.length === 0) {
    new Notice('No entries found in the database');
    return 0;
  }

  let createdOrUpdated = 0;
  for (const page of allResults) {
    if (!('properties' in page)) continue;

    let title = 'Untitled';
    let createdDate = new Date().toISOString();

    if ('created_time' in page) {
      createdDate = (page as PageObjectResponse).created_time;
    }

    for (const [, prop] of Object.entries((page as PageObjectResponse).properties)) {
      if (prop.type === 'title' && Array.isArray(prop.title)) {
        title = prop.title[0]?.plain_text || 'Untitled';
      }
      if (prop.type === 'date' && prop.date?.start) {
        createdDate = prop.date.start;
      }
    }

    const content = await ctx.getPageContent(page.id);

    const existingFile = await ctx.appVault.findFileByNotionPageId(page.id);
    if (existingFile) {
      const localContent = await ctx.appVault.read(existingFile);
      const localEdited = (localContent.match(/last_edited_time:\s*["]?([^"'\n]+)["']?/) || [])[1];
      const notionEdited = (page as any).last_edited_time as string | undefined;

      if (notionEdited && localEdited && new Date(notionEdited) > new Date(localEdited)) {
        await ctx.appVault.modify(existingFile, content);
        createdOrUpdated++;
        new Notice(`Updated ${existingFile.basename} from Notion`);
        continue;
      }

      // Normalize required frontmatter fields even when Notion is not newer
      let normalized = replaceFrontmatterField(localContent, 'notion_page_id', page.id);
      normalized = replaceFrontmatterField(normalized, 'imported_from', 'notion');
      if (notionEdited) {
        normalized = replaceFrontmatterField(normalized, 'last_edited_time', notionEdited);
      }
      if (normalized !== localContent) {
        await ctx.appVault.modify(existingFile, normalized);
      }
      continue;
    }

    const fileName = ctx.appVault.generateFileName(title, createdDate);
    const filePath = `${ctx.destinationFolder}/${fileName}.md`;
    try {
      await ctx.appVault.create(filePath, content);
      createdOrUpdated++;
    } catch (error: any) {
      if (error?.message?.includes('already exists')) {
        // skip silently
      } else {
        new Notice(`Error creating file ${fileName}: ${error.message}`);
      }
    }
  }

  return createdOrUpdated;
}
