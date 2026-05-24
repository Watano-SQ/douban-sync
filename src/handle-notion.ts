import { consola } from 'consola';
import dayjs from 'dayjs';
import dotenv from 'dotenv';
import got from 'got';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@notionhq/client';
import { type CreatePageParameters } from '@notionhq/client/build/src/api-endpoints';

import scrapyDouban from './handle-douban';
import { getDataSourceId, sleep, buildPropertyValue } from './utils';
import { PropertyTypeMap, EMOJI } from './const';
import DB_PROPERTIES from '../cols.json';
import {
  ItemCategory,
  type FeedItem,
  type NotionUrlPropType,
  type DB_PROPERTIES_KEYS,
  type FailedItem,
} from './types';

// https://github.com/makenotion/notion-sdk-js/issues/280#issuecomment-1178523498
type EmojiRequest = Extract<CreatePageParameters['icon'], { type: 'emoji' }>['emoji'];

dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: '2025-09-03',
});

const DOUBAN_COVER_CACHE_DIR = 'covers/douban';
const IMAGE_REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Referer: 'https://book.douban.com/',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
};

/**
 * Handles Notion feeds by grouping them by category and syncing each category
 * to its corresponding Notion data source.
 */
export default async function handleNotion(feeds: FeedItem[]): Promise<void> {
  const groupByCategory: Partial<Record<ItemCategory, FeedItem[]>> = feeds.reduce(
    (acc, feed) => {
      if (!acc[feed.category]) {
        acc[feed.category] = [];
      }

      acc[feed.category]!.push(feed);
      return acc;
    },
    {} as Partial<Record<ItemCategory, FeedItem[]>>,
  );

  const allFailedItems: FailedItem[] = [];

  for (const category in groupByCategory) {
    try {
      const categorizedFeeds = groupByCategory[category as ItemCategory] as FeedItem[];
      const failed = await syncNotionDB(categorizedFeeds, category as ItemCategory);

      if (failed) {
        allFailedItems.push(...failed);
      }
    } catch (error) {
      consola.error(`Failed to handle ${category} feeds.\n`, error);
      process.exit(1);
    }
  }

  if (allFailedItems.length) {
    consola.warn('Failed to handle the following feeds to insert into Notion:');

    for (const item of allFailedItems) {
      consola.warn(`${item.title}: ${item.link}`);
    }

    process.exit(1);
  }
}

/**
 * Synchronizes one category of feed items to its corresponding Notion data source.
 */
async function syncNotionDB(
  categorizedFeeds: FeedItem[],
  category: ItemCategory,
): Promise<FailedItem[] | undefined> {
  if (categorizedFeeds.length === 0) {
    consola.info(`No new ${category} feeds.`);
    return;
  }

  const dataSourceId = getDataSourceId(category);

  if (!dataSourceId) {
    consola.warn(`No notion data source id for ${category}`);
    return;
  }

  consola.start(`Handling ${category} feeds...`);

  // After @notionhq/sdk upgraded to v5.0.0, use dataSource instead of database.
  const queryItems = await notion.dataSources
    .query({
      data_source_id: dataSourceId,
      filter: {
        or: categorizedFeeds.map((item) => ({
          property: DB_PROPERTIES.ITEM_LINK,
          url: {
            contains: item.id,
          },
        })),
      },
    })
    .catch((error) => {
      consola.error(
        `Failed to query ${category} database to check already inserted items.\n`,
        error,
      );
      process.exit(1);
    });

  const alreadyInsertedItems = new Set<string>(
    queryItems.results
      .map((i) => {
        if ('properties' in i) {
          return (i.properties[DB_PROPERTIES.ITEM_LINK] as NotionUrlPropType).url;
        }

        return undefined;
      })
      .filter((v): v is string => Boolean(v)),
  );

  const newFeeds = categorizedFeeds.filter((item) => {
    return !alreadyInsertedItems.has(item.link);
  });

  consola.info(`There are total ${newFeeds.length} new ${category} item(s) need to insert.`);

  const failedItems: FailedItem[] = [];

  for (const newFeedItem of newFeeds) {
    try {
      const itemData = await scrapyDouban(newFeedItem.link, category);

      itemData[DB_PROPERTIES.ITEM_LINK] = newFeedItem.link;
      itemData[DB_PROPERTIES.RATING] = newFeedItem.rating;
      itemData[DB_PROPERTIES.RATING_DATE] = dayjs(newFeedItem.time).format('YYYY-MM-DD');
      itemData[DB_PROPERTIES.COMMENTS] = newFeedItem.comment;

      const successful = await addItemToNotion(itemData, category);

      if (!successful) {
        failedItems.push({
          link: newFeedItem.link,
          title: String(itemData[DB_PROPERTIES.NAME] || newFeedItem.link),
        });
      }

      await sleep(1000);
    } catch (error) {
      consola.error(error);
      continue;
    }
  }

  if (failedItems.length) {
    consola.error(`Failed to insert ${failedItems.length} items into ${category} Notion database.`);
  }

  consola.success(`${category} feeds done.`);
  consola.log('====================');

  return failedItems;
}

/**
 * Extracts the raw external poster/cover URL from scraped Douban item data.
 *
 * Important:
 * This reads from raw itemData, not from Notion properties.
 * Notion properties may later be filtered by existing data source columns.
 * If the Notion database does not have a "封面" or "海报" column, the property
 * would be deleted; but page cover should still be set.
 */
function getRawExternalImageUrl(itemData: {
  [key: string]: string | string[] | number | null | undefined;
}): string | undefined {
  const value = itemData[DB_PROPERTIES.POSTER] || itemData[DB_PROPERTIES.COVER];

  if (typeof value !== 'string') {
    return undefined;
  }

  const url = value.trim();

  if (!/^https?:\/\//i.test(url)) {
    return undefined;
  }

  return url;
}

function encodeRawGitHubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function getImageFileNameFromUrl(url: string): string {
  const { pathname } = new URL(url);
  const fileName = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');

  if (safeFileName) {
    return safeFileName;
  }

  return 'douban-cover.jpg';
}

function buildCachedCoverPath(url: string): string {
  return `${DOUBAN_COVER_CACHE_DIR}/${getImageFileNameFromUrl(url)}`;
}

function buildRawGitHubUrl(repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${encodeRawGitHubPath(path)}`;
}

function isDoubanioUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('doubanio.com');
  } catch {
    return false;
  }
}

async function cacheCoverForNotion(sourceUrl?: string): Promise<string | undefined> {
  if (!sourceUrl) {
    return undefined;
  }

  if (!isDoubanioUrl(sourceUrl)) {
    return sourceUrl;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const branch = process.env.GITHUB_REF_NAME || 'main';
  const cachedCoverPath = buildCachedCoverPath(sourceUrl);

  if (!repo) {
    consola.warn(`Missing GITHUB_REPOSITORY. Fall back to original cover url: ${sourceUrl}`);
    return sourceUrl;
  }

  const rawUrl = buildRawGitHubUrl(repo, branch, cachedCoverPath);
  const localPath = path.join(process.cwd(), ...cachedCoverPath.split('/'));

  try {
    if (existsSync(localPath)) {
      consola.info(`Using cached cover: ${cachedCoverPath}`);
      return rawUrl;
    }

    const imageResponse = await got.get(sourceUrl, {
      responseType: 'buffer',
      headers: IMAGE_REQUEST_HEADERS,
    });
    const contentTypeHeader = imageResponse.headers['content-type'];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;

    if (!contentType?.toLowerCase().startsWith('image/')) {
      throw new Error(`Unexpected cover content type: ${contentType || 'unknown'}`);
    }

    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, imageResponse.body);

    consola.success(`Cached Douban cover locally: ${cachedCoverPath}`);
    return rawUrl;
  } catch (error) {
    consola.warn(`Failed to cache cover. Fall back to original cover url: ${sourceUrl}`);
    consola.warn(error);
    return sourceUrl;
  }
}

/**
 * Inserts one item into a Notion data source.
 */
async function addItemToNotion(
  itemData: {
    [key: string]: string | string[] | number | null | undefined;
  },
  category: ItemCategory,
): Promise<boolean> {
  consola.start(
    'Going to insert ',
    itemData[DB_PROPERTIES.RATING_DATE],
    itemData[DB_PROPERTIES.NAME],
  );

  try {
    const rawCoverUrl = await cacheCoverForNotion(getRawExternalImageUrl(itemData));

    const properties: Record<string, any> = {};

    const keys = (Object.keys(DB_PROPERTIES) as Array<keyof typeof DB_PROPERTIES>).filter(
      (key) => key !== 'NAME',
    ) as DB_PROPERTIES_KEYS[];

    keys.forEach((key) => {
      const propertyName = DB_PROPERTIES[key];
      const value = itemData[propertyName];

      if (value === undefined || value === null || value === '') {
        return;
      }

      const propertyValue = buildPropertyValue(value, PropertyTypeMap[key], propertyName);

      if (propertyValue) {
        properties[propertyName] = propertyValue;
      }
    });

    const dataSourceId = getDataSourceId(category);

    if (!dataSourceId) {
      throw new Error('No data source id found for category: ' + category);
    }

    const db = await notion.dataSources.retrieve({
      data_source_id: dataSourceId,
    });

    const columns = Object.keys(db.properties);

    // Remove columns which are not in the current Notion data source.
    // rawCoverUrl has already been captured before this filtering.
    const propKeys = Object.keys(properties);

    propKeys.forEach((prop) => {
      if (columns.indexOf(prop) < 0) {
        delete properties[prop];
      }
    });

    const postData: CreatePageParameters = {
      parent: {
        type: 'data_source_id',
        data_source_id: dataSourceId,
      },
      icon: {
        type: 'emoji',
        emoji: EMOJI[category] as EmojiRequest,
      },
      properties,
    };

    if (rawCoverUrl) {
      // Use Douban poster/cover as Notion page cover.
      postData.cover = {
        type: 'external',
        external: {
          url: rawCoverUrl,
        },
      };

      // Also put the same image into the page body.
      postData.children = [
        {
          object: 'block',
          type: 'image',
          image: {
            type: 'external',
            external: {
              url: rawCoverUrl,
            },
          },
        },
      ] as any;
    }

    const response = await notion.pages.create(postData);

    if (response && response.id) {
      consola.success(
        itemData[DB_PROPERTIES.NAME] +
          `[${itemData[DB_PROPERTIES.ITEM_LINK]}]` +
          ' page inserted into Notion database.',
      );
    }

    return true;
  } catch (error) {
    consola.error(
      'Failed to create ' +
        itemData[DB_PROPERTIES.NAME] +
        `(${itemData[DB_PROPERTIES.ITEM_LINK]})` +
        ' with error: ',
      error,
    );

    return false;
  }
}
