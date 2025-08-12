import { Client } from '@notionhq/client';
import { BlockObjectResponse } from '@notionhq/client/build/src/api-endpoints';
import { listAllChildBlocks, withRetry } from './utils';

interface BlockDiff {
  type: 'create' | 'update' | 'delete' | 'unchanged';
  blockId?: string;
  content: any;
  position: number;
}

interface ContentDiffResult {
  hasChanges: boolean;
  diffs: BlockDiff[];
  titleChanged: boolean;
  newTitle?: string;
}

export class ContentDiffer {
  constructor(private notion: Client) {}

  async diffPageContent(pageId: string, newMarkdown: string, newTitle: string): Promise<ContentDiffResult> {
    try {
      // Get current page content and title
      const [currentBlocks, currentPage] = await Promise.all([
        listAllChildBlocks(this.notion, pageId),
        withRetry(() => this.notion.pages.retrieve({ page_id: pageId }))
      ]);

      // Extract current title
      let currentTitle = '';
      if ('properties' in currentPage) {
        for (const [key, prop] of Object.entries((currentPage as any).properties)) {
          if ((prop as any).type === 'title' && (prop as any).title.length > 0) {
            currentTitle = (prop as any).title.map((t: any) => t.plain_text).join('');
            break;
          }
        }
      }

      const titleChanged = currentTitle !== newTitle;

      // Convert new markdown to blocks
      const newBlocks = this.markdownToBlocks(newMarkdown);
      
      // Compare block structure
      const diffs = this.compareBlocks(currentBlocks, newBlocks);
      const hasChanges = diffs.some(diff => diff.type !== 'unchanged') || titleChanged;

      return {
        hasChanges,
        diffs,
        titleChanged,
        newTitle: titleChanged ? newTitle : undefined
      };
    } catch (error) {
      console.error('Error diffing content:', error);
      // Fallback to full replacement on error
      return {
        hasChanges: true,
        diffs: [],
        titleChanged: true,
        newTitle: newTitle
      };
    }
  }

  private compareBlocks(currentBlocks: BlockObjectResponse[], newBlocks: any[]): BlockDiff[] {
    const diffs: BlockDiff[] = [];
    const maxLength = Math.max(currentBlocks.length, newBlocks.length);

    for (let i = 0; i < maxLength; i++) {
      const currentBlock = currentBlocks[i];
      const newBlock = newBlocks[i];

      if (!currentBlock && newBlock) {
        // New block to create
        diffs.push({
          type: 'create',
          content: newBlock,
          position: i
        });
      } else if (currentBlock && !newBlock) {
        // Block to delete
        diffs.push({
          type: 'delete',
          blockId: currentBlock.id,
          content: null,
          position: i
        });
      } else if (currentBlock && newBlock) {
        // Compare existing blocks
        if (this.blocksEqual(currentBlock, newBlock)) {
          diffs.push({
            type: 'unchanged',
            blockId: currentBlock.id,
            content: newBlock,
            position: i
          });
        } else {
          diffs.push({
            type: 'update',
            blockId: currentBlock.id,
            content: newBlock,
            position: i
          });
        }
      }
    }

    return diffs;
  }

  private blocksEqual(current: BlockObjectResponse, newBlock: any): boolean {
    try {
      if ((current as any).type !== newBlock.type) {
        return false;
      }

      const type = (current as any).type;
      
      // Compare content based on block type
      switch (type) {
        case 'paragraph':
          return this.richTextEqual((current as any).paragraph.rich_text, newBlock.paragraph?.rich_text);
        
        case 'heading_1':
          return this.richTextEqual((current as any).heading_1.rich_text, newBlock.heading_1?.rich_text);
        
        case 'heading_2':
          return this.richTextEqual((current as any).heading_2.rich_text, newBlock.heading_2?.rich_text);
        
        case 'heading_3':
          return this.richTextEqual((current as any).heading_3.rich_text, newBlock.heading_3?.rich_text);
        
        case 'bulleted_list_item':
          return this.richTextEqual((current as any).bulleted_list_item.rich_text, newBlock.bulleted_list_item?.rich_text);
        
        case 'numbered_list_item':
          return this.richTextEqual((current as any).numbered_list_item.rich_text, newBlock.numbered_list_item?.rich_text);
        
        case 'to_do':
          return (current as any).to_do.checked === newBlock.to_do?.checked && 
                 this.richTextEqual((current as any).to_do.rich_text, newBlock.to_do?.rich_text);
        
        case 'code':
          return (current as any).code.language === newBlock.code?.language &&
                 this.richTextEqual((current as any).code.rich_text, newBlock.code?.rich_text);
        
        case 'quote':
          return this.richTextEqual((current as any).quote.rich_text, newBlock.quote?.rich_text);
        
        case 'divider':
          return true; // Dividers are always equal
        
        default:
          // For unknown types, assume they're different to be safe
          return false;
      }
    } catch (error) {
      console.error('Error comparing blocks:', error);
      return false;
    }
  }

  private richTextEqual(current: any[], newRichText: any[]): boolean {
    if (!current && !newRichText) return true;
    if (!current || !newRichText) return false;
    if (current.length !== newRichText.length) return false;

    for (let i = 0; i < current.length; i++) {
      const currentText = current[i]?.plain_text || '';
      const newText = newRichText[i]?.text?.content || '';
      if (currentText !== newText) {
        return false;
      }
    }

    return true;
  }

  private markdownToBlocks(markdown: string): any[] {
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
      
      if (line.startsWith('- ') && !line.match(/^- \[[x ]\]/)) {
        flushParagraph();
        blocks.push({
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] },
        });
        continue;
      }
      
      if (line.match(/^- \[[x ]\]/)) {
        flushParagraph();
        const checked = line.includes('[x]');
        const content = line.replace(/^- \[[x ]\]\s*/, '');
        blocks.push({
          object: 'block',
          type: 'to_do',
          to_do: { 
            checked,
            rich_text: [{ type: 'text', text: { content } }]
          },
        });
        continue;
      }
      
      if (line.match(/^\d+\. /)) {
        flushParagraph();
        blocks.push({
          object: 'block',
          type: 'numbered_list_item',
          numbered_list_item: { rich_text: [{ type: 'text', text: { content: line.replace(/^\d+\. /, '') } }] },
        });
        continue;
      }
      
      if (line.startsWith('> ')) {
        flushParagraph();
        blocks.push({
          object: 'block',
          type: 'quote',
          quote: { rich_text: [{ type: 'text', text: { content: line.slice(2) } }] },
        });
        continue;
      }
      
      if (line.trim() === '---') {
        flushParagraph();
        blocks.push({
          object: 'block',
          type: 'divider',
          divider: {},
        });
        continue;
      }
      
      if (line.startsWith('```')) {
        flushParagraph();
        const language = line.slice(3) || 'text';
        let codeContent = '';
        // This is simplified - in a real implementation you'd need to handle multi-line code blocks
        blocks.push({
          object: 'block',
          type: 'code',
          code: {
            language,
            rich_text: [{ type: 'text', text: { content: codeContent } }]
          },
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
}
