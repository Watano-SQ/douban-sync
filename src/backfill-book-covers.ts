import { consola } from 'consola';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';

import scrapyDouban from './handle-douban';
import { cacheCoverForNotion, getCachedCoverPreviewUrl } from './cover-cache';
import { sleep } from './utils';
import DB_PROPERTIES from '../cols.json';
import { ItemCategory, type NotionUrlPropType } from './types';

dotenv.config();

type PageLike = {
  object: string;
  id: string;
  cover?: unknown;
  properties?: Record<string, any>;
};

type BackfillStats = {
  scanned: number;
  skippedAlreadyHasCover: number;
  skippedNoLink: number;
  skippedNoCover: number;
  updated: number;
  failed: number;
};

function isTruthyEnv(value?: string): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function isDryRunEnv(value?: string): boolean {
  if (!value) {
    return true;
  }

  return value !== '0' && value.toLowerCase() !== 'false';
}

function getBackfillLimit(): number | undefined {
  const rawLimit = process.env.BACKFILL_LIMIT?.trim();

  if (!rawLimit) {
    return undefined;
  }

  const limit = Number(rawLimit);

  if (!Number.isFinite(limit) || limit <= 0) {
    consola.warn(`Invalid BACKFILL_LIMIT ignored: ${rawLimit}`);
    return undefined;
  }

  return Math.floor(limit);
}

function requireEnv(key: string): string {
  const value = process.env[key]?.trim();

  if (!value) {
    consola.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }

  return value;
}

function getPageTitle(page: PageLike): string {
  const nameProperty = page.properties?.[DB_PROPERTIES.NAME];

  if (nameProperty?.type === 'title' && Array.isArray(nameProperty.title)) {
    return nameProperty.title.map((part: any) => part.plain_text || '').join('').trim();
  }

  const titleProperty = Object.values(page.properties || {}).find((property: any) => {
    return property?.type === 'title' && Array.isArray(property.title);
  });

  if (titleProperty) {
    return (titleProperty as any).title.map((part: any) => part.plain_text || '').join('').trim();
  }

  return page.id;
}

function getItemLink(page: PageLike): string | undefined {
  const property = page.properties?.[DB_PROPERTIES.ITEM_LINK] as NotionUrlPropType | undefined;
  const url = property?.url?.trim();

  if (!url) {
    return undefined;
  }

  return url;
}

function isDoubanBookSubjectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      parsed.hostname === 'book.douban.com' &&
      /^\/subject\/\d+\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

async function queryBookPages(
  notion: Client,
  dataSourceId: string,
  limit?: number,
): Promise<PageLike[]> {
  const pages: PageLike[] = [];
  let startCursor: string | undefined;

  do {
    const response = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: startCursor,
    });

    for (const result of response.results) {
      if (result.object !== 'page') {
        continue;
      }

      pages.push(result as PageLike);

      if (limit && pages.length >= limit) {
        return pages;
      }
    }

    startCursor = response.has_more ? response.next_cursor || undefined : undefined;
  } while (startCursor);

  return pages;
}

async function backfillBookCovers(): Promise<void> {
  const notionToken = requireEnv('NOTION_TOKEN');
  const dataSourceId = requireEnv('NOTION_BOOK_DATABASE_ID');
  const dryRun = isDryRunEnv(process.env.BACKFILL_DRY_RUN);
  const force = isTruthyEnv(process.env.BACKFILL_FORCE);
  const limit = getBackfillLimit();
  const notion = new Client({
    auth: notionToken,
    notionVersion: '2025-09-03',
  });
  const stats: BackfillStats = {
    scanned: 0,
    skippedAlreadyHasCover: 0,
    skippedNoLink: 0,
    skippedNoCover: 0,
    updated: 0,
    failed: 0,
  };

  consola.info(
    `Backfilling book covers. dry_run=${dryRun ? 'true' : 'false'}, force=${force ? 'true' : 'false'}, limit=${limit || 'none'}`,
  );

  const dataSource = await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  });
  const hasCoverProperty = Object.prototype.hasOwnProperty.call(
    dataSource.properties,
    DB_PROPERTIES.COVER,
  ) && (dataSource.properties as Record<string, any>)[DB_PROPERTIES.COVER]?.type === 'files';
  const pages = await queryBookPages(notion, dataSourceId, limit);

  for (const page of pages) {
    stats.scanned += 1;

    try {
      const title = getPageTitle(page);

      if (page.cover && !force) {
        stats.skippedAlreadyHasCover += 1;
        consola.info(`Skip existing cover: ${title}`);
        continue;
      }

      const itemLink = getItemLink(page);

      if (!itemLink || !isDoubanBookSubjectUrl(itemLink)) {
        stats.skippedNoLink += 1;
        consola.warn(`Skip page without Douban book link: ${title}`);
        continue;
      }

      const itemData = await scrapyDouban(itemLink, ItemCategory.Book);
      const coverUrl = itemData[DB_PROPERTIES.COVER];

      if (typeof coverUrl !== 'string' || !coverUrl.trim()) {
        stats.skippedNoCover += 1;
        consola.warn(`Skip page without scraped cover: ${title} (${itemLink})`);
        await sleep(1000);
        continue;
      }

      const originalCoverUrl = coverUrl.trim();
      const cachedCoverUrl = dryRun
        ? getCachedCoverPreviewUrl(originalCoverUrl)
        : await cacheCoverForNotion(originalCoverUrl);

      if (!cachedCoverUrl) {
        stats.skippedNoCover += 1;
        consola.warn(`Skip page because cached cover url is empty: ${title} (${itemLink})`);
        await sleep(1000);
        continue;
      }

      if (dryRun) {
        consola.info(
          [
            'Dry run cover backfill:',
            `title=${title}`,
            `item link=${itemLink}`,
            `original cover=${originalCoverUrl}`,
            `cached cover=${cachedCoverUrl}`,
          ].join('\n'),
        );
      } else {
        const properties: Record<string, any> = {};

        if (hasCoverProperty) {
          properties[DB_PROPERTIES.COVER] = {
            type: 'files',
            files: [
              {
                name: cachedCoverUrl,
                type: 'external',
                external: {
                  url: cachedCoverUrl,
                },
              },
            ],
          };
        }

        await notion.pages.update({
          page_id: page.id,
          cover: {
            type: 'external',
            external: {
              url: cachedCoverUrl,
            },
          },
          ...(hasCoverProperty ? { properties } : {}),
        });

        stats.updated += 1;
        consola.success(`Updated cover: ${title} (${itemLink})`);
      }

      await sleep(1000);
    } catch (error) {
      stats.failed += 1;
      consola.error(`Failed to backfill page ${page.id}:`, error);
    }
  }

  consola.box(
    [
      'Backfill book covers summary',
      `scanned: ${stats.scanned}`,
      `skippedAlreadyHasCover: ${stats.skippedAlreadyHasCover}`,
      `skippedNoLink: ${stats.skippedNoLink}`,
      `skippedNoCover: ${stats.skippedNoCover}`,
      `updated: ${stats.updated}`,
      `failed: ${stats.failed}`,
    ].join('\n'),
  );
}

backfillBookCovers().catch((error) => {
  consola.error('Failed to backfill book covers:', error);
  process.exit(1);
});
