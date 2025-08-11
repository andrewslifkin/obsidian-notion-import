import { Notice, TFile } from 'obsidian';
import type { Client } from '@notionhq/client';
import type { PageObjectResponse, BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { withRetry, listAllChildBlocks } from '../utils';

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
}

export async function importDatabase(ctx: ImportContext, databaseId: string): Promise<number> {
  await ctx.appVault.ensureFolderExists(ctx.destinationFolder);

  const db = await withRetry(() => ctx.notion.databases.retrieve({ database_id: databaseId }));

  const response = await withRetry(() => ctx.notion.databases.query({ database_id: databaseId }));
  if (!response.results || response.results.length === 0) {
    new Notice('No entries found in the database');
    return 0;
  }

  let createdOrUpdated = 0;
  for (const page of response.results) {
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
