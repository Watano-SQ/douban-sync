import Parser from 'rss-parser';
import dotenv from 'dotenv';
import got from 'got';
import { JSDOM } from 'jsdom';
import { consola } from 'consola';

import {
  ALL_STATUS,
  RATING_TEXT,
  SeeState,
  ReadState,
  PlayState,
  ListenState,
} from './const';
import {
  ItemCategory,
  ItemStatus,
  type RSSFeedItem,
  type FeedItem,
} from './types';

type ItemInfo = {
  category: ItemCategory;
  id: string;
  status: ItemStatus;
};

dotenv.config();

function getDoubanRSSUrl(): string {
  const DOUBAN_USER_ID = process.env.DOUBAN_USER_ID?.trim();

  if (!DOUBAN_USER_ID) {
    consola.error('Missing environment variable: DOUBAN_USER_ID');
    process.exit(1);
  }

  return `https://www.douban.com/feed/people/${DOUBAN_USER_ID}/interests`;
}

function getDoubanRSSHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept:
      'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://www.douban.com/',
    Connection: 'keep-alive',
  };

  const cookie = process.env.DOUBAN_COOKIE?.trim();

  if (cookie) {
    headers.Cookie = cookie;
  }

  return headers;
}

function looksLikeDoubanLoginPage(body: string): boolean {
  const preview = body.slice(0, 1000).toLowerCase();

  return (
    /<html[\s>]/i.test(body) &&
    (preview.includes('豆瓣 - 登录跳转页') ||
      preview.includes('登录跳转页') ||
      preview.includes('login'))
  );
}

export async function fetchRSSFeeds(): Promise<RSSFeedItem[]> {
  const rssUrl = getDoubanRSSUrl();
  const parser = new Parser();

  try {
    consola.info(`Fetching Douban RSS: ${rssUrl}`);

    const response = await got.get(rssUrl, {
      headers: getDoubanRSSHeaders(),
      followRedirect: true,
      throwHttpErrors: false,
    });

    const body = response.body;

    if (response.statusCode < 200 || response.statusCode >= 300) {
      consola.error(`Failed to fetch Douban RSS. HTTP status: ${response.statusCode}`);
      consola.error(`Response preview:\n${body.slice(0, 500)}`);
      process.exit(1);
    }

    if (looksLikeDoubanLoginPage(body)) {
      consola.error('Douban RSS returned login page. Please update DOUBAN_COOKIE secret.');
      consola.error(`Response preview:\n${body.slice(0, 500)}`);
      process.exit(1);
    }

    const feeds = await parser.parseString(body);

    return feeds.items as RSSFeedItem[];
  } catch (error) {
    consola.error('Failed to parse RSS url: ', error);
    process.exit(1);
  }
}

/**
 * Normalize the given array of RSS feed items.
 *
 * @param {RSSFeedItem[]} feeds - The array of RSS feed items to be normalized.
 * @return {FeedItem[]} The normalized array of feed items.
 */
export function handleRSSFeeds(feeds: RSSFeedItem[]): FeedItem[] {
  const normalizedFeeds: FeedItem[] = [];

  feeds.forEach((item) => {
    const itemInfo = extractItemInfo(item.title!, item.link!);

    if (!itemInfo) {
      return;
    }

    const { category, id, status } = itemInfo;

    const dom = new JSDOM(item.content!.trim());
    const contents = [...dom.window.document.querySelectorAll('td p')];

    const ratingElements = contents.filter((el) => el.textContent!.startsWith('推荐'));
    let ratingNumber = 0;

    if (ratingElements.length) {
      const rating = ratingElements[0].textContent!.replace(/^推荐: /, '').trim();

      ratingNumber = RATING_TEXT[rating as keyof typeof RATING_TEXT];
    }

    const commentElements = contents.filter((el) => el.textContent!.startsWith('备注'));
    let comment = '';

    if (commentElements.length) {
      comment = commentElements[0].textContent!.replace(/^备注: /, '').trim();
    }

    const result = {
      id,
      link: item.link,
      rating: ratingNumber || null,
      comment: typeof comment === 'string' ? comment : null,
      time: item.isoDate,
      status,
      category,
    } as FeedItem;

    normalizedFeeds.push(result);
  });

  return normalizedFeeds;
}

/**
 * Extracts the category, ID, and status from the given title and link
 * which are from RSS feed item.
 *
 * @param {string} title - The title to extract the information from.
 * @param {string} link - The link to extract the information from.
 * @return {ItemInfo} An object containing the extracted category, ID, and status.
 */
export function extractItemInfo(title: string, link: string): ItemInfo | undefined {
  const m = title.match(ALL_STATUS)?.[1];

  if (!m) {
    return;
  }

  if (Object.keys(SeeState).includes(m)) {
    const isMovie =
      link.startsWith('http://movie.douban.com/') ||
      link.startsWith('https://movie.douban.com/');

    return {
      category: isMovie ? ItemCategory.Movie : ItemCategory.Drama,
      id: isMovie
        ? link.match(/movie\.douban\.com\/subject\/(\d+)\/?/)?.[1]!
        : link.match(/www\.douban\.com\/location\/drama\/(\d+)\/?/)?.[1]!,
      status: SeeState[m as keyof typeof SeeState],
    };
  }

  if (Object.keys(ReadState).includes(m)) {
    return {
      category: ItemCategory.Book,
      id: link.match(/book\.douban\.com\/subject\/(\d+)\/?/)?.[1]!,
      status: ReadState[m as keyof typeof ReadState],
    };
  }

  if (Object.keys(ListenState).includes(m)) {
    return {
      category: ItemCategory.Music,
      id: link.match(/music\.douban\.com\/subject\/(\d+)\/?/)?.[1]!,
      status: ListenState[m as keyof typeof ListenState],
    };
  }

  if (Object.keys(PlayState).includes(m)) {
    return {
      category: ItemCategory.Game,
      id: link.match(/www\.douban\.com\/game\/(\d+)\/?/)?.[1]!,
      status: PlayState[m as keyof typeof PlayState],
    };
  }

  return;
}
