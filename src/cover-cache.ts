import { consola } from 'consola';
import got from 'got';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const DOUBAN_COVER_CACHE_DIR = 'covers/douban';
const IMAGE_REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Referer: 'https://book.douban.com/',
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
};

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

export function getCachedCoverPreviewUrl(sourceUrl: string): string | undefined {
  if (!isDoubanioUrl(sourceUrl)) {
    return sourceUrl;
  }

  const repo = process.env.GITHUB_REPOSITORY;

  if (!repo) {
    return sourceUrl;
  }

  const branch = process.env.GITHUB_REF_NAME || 'main';
  const cachedCoverPath = buildCachedCoverPath(sourceUrl);

  return buildRawGitHubUrl(repo, branch, cachedCoverPath);
}

export async function cacheCoverForNotion(sourceUrl?: string): Promise<string | undefined> {
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
