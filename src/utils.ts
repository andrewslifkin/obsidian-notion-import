import { App, Modal, Notice } from 'obsidian';
import type { Client } from '@notionhq/client';
import type { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: any) => boolean;
};

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    retries = 6,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    retryOn = (error: any) => {
      const status = error?.status ?? error?.response?.status;
      return status === 429 || (status >= 500 && status < 600);
    },
  } = options;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > retries || !retryOn(error)) {
        throw error;
      }
      const isRateLimited = (error as any)?.status === 429;
      const jitter = Math.random() * 0.25 + 0.75; // 0.75x - 1x
      let delay = Math.min(maxDelayMs, Math.round(baseDelayMs * Math.pow(2, attempt - 1) * jitter));
      if (isRateLimited) {
        // Respect rate limits with a longer floor when 429 is encountered
        delay = Math.max(delay, 5000);
      }
      console.warn(`Retrying after error (attempt ${attempt}/${retries}) in ${delay}ms`, error);
      await sleep(delay);
    }
  }
}

export async function listAllChildBlocks(notion: Client, blockId: string): Promise<BlockObjectResponse[]> {
  let results: BlockObjectResponse[] = [];
  let cursor: string | undefined = undefined;

  do {
    const page = await withRetry(() =>
      notion.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor }),
    );
    results = results.concat(page.results as BlockObjectResponse[]);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  return results;
}

export async function listAllNestedChildren(notion: Client, parentBlocks: BlockObjectResponse[]): Promise<Record<string, BlockObjectResponse[]>> {
  const map: Record<string, BlockObjectResponse[]> = {};
  for (const block of parentBlocks) {
    if ('has_children' in block && (block as any).has_children) {
      const nested = await listAllChildBlocks(notion, block.id);
      map[block.id] = nested;
    }
  }
  return map;
}

export function extractFrontmatter(content: string): { raw: string; data: Record<string, string> } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const data: Record<string, string> = {};
  if (!match) {
    return { raw: '', data };
  }
  const raw = match[1];
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
    if (key) data[key] = value;
  }
  return { raw: match[0], data };
}

export function replaceFrontmatterField(content: string, key: string, value: string): string {
  const hasFrontmatter = /^---\n([\s\S]*?)\n---/m.test(content);
  if (!hasFrontmatter) {
    // Create new frontmatter
    const block = `---\n${key}: ${quoteIfNeeded(value)}\n---\n\n`;
    return block + content;
  }
  const { raw, data } = extractFrontmatter(content);
  data[key] = value;

  const rebuilt = Object.entries(data)
    .map(([k, v]) => `${k}: ${quoteIfNeeded(v)}`)
    .join('\n');

  const newFrontmatter = `---\n${rebuilt}\n---`;
  return content.replace(/^---\n([\s\S]*?)\n---/, newFrontmatter);
}

export function quoteIfNeeded(value: string): string {
  const needsQuotes = /[\n"':]/.test(value);
  return needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function getNotionPageIdFromContent(content: string): string | null {
  const match = content.match(/notion_page_id:\s*["]?([^"'\n]+)["']?/);
  return match?.[1] ?? null;
}

export function getLastEditedTimeFromContent(content: string): string | null {
  const match = content.match(/last_edited_time:\s*["]?([^"'\n]+)["']?/);
  return match?.[1] ?? null;
}

export function setLastEditedTimeInContent(content: string, value: string): string {
  if (/last_edited_time:\s*/.test(content)) {
    return content.replace(/last_edited_time:\s*["]?([^"'\n]+)["']?/, `last_edited_time: "${value}"`);
  }
  return replaceFrontmatterField(content, 'last_edited_time', value);
}

export function parseTitleFromFrontmatter(content: string, fallback: string): string {
  const match = content.match(/title:\s*["]?([^"'\n]+)["']?/);
  return match?.[1] ?? fallback;
}

export function normalizeFileStem(stem: string): string {
  return stem
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type FileNameSettings = {
  includeDateInFilename: boolean;
  dateSource: 'created' | 'current';
  dateFormat: string;
  datePosition: 'prefix' | 'suffix';
  dateSeparator: string;
};

export function buildFileName(settings: FileNameSettings, title: string, createdISO?: string, nowISO?: string, formatDate: (iso: string, fmt: string) => string = (iso, fmt) => iso): string {
  const stem = normalizeFileStem(title);
  if (!settings.includeDateInFilename) return stem;

  const dateStr = settings.dateSource === 'created' && createdISO
    ? formatDate(createdISO, settings.dateFormat)
    : formatDate(nowISO ?? new Date().toISOString(), settings.dateFormat);

  return settings.datePosition === 'prefix'
    ? `${dateStr}${settings.dateSeparator}${stem}`
    : `${stem}${settings.dateSeparator}${dateStr}`;
}

export function pathIsWithinFolder(path: string, folder: string): boolean {
  const normalizedFolder = folder.endsWith('/') ? folder : folder + '/';
  return path === folder || path.startsWith(normalizedFolder);
}

export class ConflictResolutionModal extends Modal {
  private onResolve: (choice: 'keep-local' | 'keep-notion' | 'cancel') => void;

  constructor(app: App, onResolve: (choice: 'keep-local' | 'keep-notion' | 'cancel') => void) {
    super(app);
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Conflict detected' });
    contentEl.createEl('p', { text: 'The Notion page has newer content than your local note. Choose which version to keep.' });

    const buttonRow = contentEl.createDiv({ cls: 'modal-button-container' });

    const keepLocal = buttonRow.createEl('button', { text: 'Keep Local' });
    keepLocal.addEventListener('click', () => {
      this.onResolve('keep-local');
      this.close();
    });

    const keepNotion = buttonRow.createEl('button', { text: 'Keep Notion' });
    keepNotion.addEventListener('click', () => {
      this.onResolve('keep-notion');
      this.close();
    });

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.onResolve('cancel');
      this.close();
    });
  }
}

// Basic Notion block -> Markdown conversion (subset)
export async function blockToMarkdown(notion: Client, block: BlockObjectResponse): Promise<string> {
  switch (block.type) {
    case 'paragraph':
      return (block.paragraph.rich_text || []).map((t: any) => t.plain_text).join('');
    case 'heading_1':
      return `# ${(block.heading_1.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    case 'heading_2':
      return `## ${(block.heading_2.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    case 'heading_3':
      return `### ${(block.heading_3.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    case 'bulleted_list_item':
      return `- ${(block.bulleted_list_item.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    case 'numbered_list_item':
      return `1. ${(block.numbered_list_item.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    case 'to_do': {
      const checked = block.to_do.checked ? 'x' : ' ';
      return `- [${checked}] ${(block.to_do.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    }
    case 'toggle':
      return `- ${(block.toggle.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    case 'quote':
      return `> ${(block.quote.rich_text || []).map((t: any) => t.plain_text).join('')}`;
    case 'divider':
      return '---';
    case 'code':
      return `\`\`\`${(block.code.language || 'text')}\n${(block.code.rich_text || []).map((t: any) => t.plain_text).join('')}\n\`\`\``;
    default:
      console.log('Unhandled block type:', block.type);
      return '';
  }
}

// Basic Markdown -> Notion blocks conversion (subset)
export function markdownToBlocks(markdown: string): any[] {
  const blocks: any[] = [];
  let currentParagraph = '';
  const lines = markdown.trim().split('\n');

  const flushParagraph = () => {
    if (currentParagraph !== '') {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: currentParagraph } }],
        },
      });
      currentParagraph = '';
    }
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    if (line.startsWith('# ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] },
      });
      continue;
    }
    if (line.startsWith('## ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: line.slice(3) } }] },
      });
      continue;
    }
    if (line.startsWith('### ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ type: 'text', text: { content: line.slice(4) } }] },
      });
      continue;
    }
    if (line.startsWith('- ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] },
      });
      continue;
    }
    // Append to paragraph
    if (currentParagraph !== '') currentParagraph += '\n';
    currentParagraph += line;
  }

  flushParagraph();
  return blocks;
}

export function showError(message: string, error?: any): void {
  console.error(message, error);
  new Notice(message);
}
