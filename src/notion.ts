import type { Client } from '@notionhq/client';
import type { APIResponseError } from '@notionhq/client/build/src';
import { NotionRateLimiter } from './rate-limiter';

export type NotionDatabaseLite = {
  id: string;
  title: string;
  url?: string;
  icon?: string | null;
};

async function execWithRateLimit<T>(
  rateLimiter: NotionRateLimiter | undefined,
  fn: () => Promise<T>,
  priority: number = 0,
): Promise<T> {
  if (rateLimiter) return rateLimiter.execute(fn, priority);
  return fn();
}

export async function notionSearchDatabases(
  notion: Client,
  rateLimiter?: NotionRateLimiter,
  query?: string,
): Promise<NotionDatabaseLite[]> {
  const results: NotionDatabaseLite[] = [];
  let startCursor: string | undefined = undefined;

  do {
    // Notion search API: can filter by object = 'database'
    const page = await execWithRateLimit(rateLimiter, () =>
      notion.search({
        query,
        filter: { property: 'object', value: 'database' } as any,
        start_cursor: startCursor,
        page_size: 100,
      })
    , 1);

    for (const item of page.results) {
      if ((item as any).object !== 'database') continue;
      const db: any = item;
      const titleParts = Array.isArray(db.title) ? db.title : [];
      const title = titleParts.map((t: any) => t?.plain_text ?? '').join('') || db.id;
      const icon = db.icon?.type === 'emoji' ? db.icon.emoji : db.icon?.type === 'file' ? db.icon.file?.url : null;
      results.push({ id: db.id, title, url: db.url, icon });
    }

    startCursor = (page as any).next_cursor ?? undefined;
  } while (startCursor);

  // De-dupe by id (defensive)
  const seen = new Set<string>();
  return results.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export async function testNotionAuth(
  notion: Client,
  rateLimiter?: NotionRateLimiter,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // Minimal call to validate token: list something via search
    await execWithRateLimit(rateLimiter, () =>
      notion.search({ page_size: 1 })
    , 1);
    return { ok: true };
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    const msg = status === 401
      ? 'Unauthorized (401): Invalid Notion token or no access.'
      : `Notion API error${status ? ` (${status})` : ''}: ${err?.message ?? 'unknown error'}`;
    return { ok: false, message: msg };
  }
}


