'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function loadEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const idx = trimmed.indexOf('=');
      if (idx <= 0) {
        continue;
      }
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {}
}

loadEnvFile(path.join(__dirname, '.env'));

const HOST = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '3010', 10) || 3010;
const BLOG_URL = String(process.env.NBLOG_BLOG_URL || 'https://blog.naver.com/fnt-jany').trim();
const BLOG_ID = String(
  process.env.NBLOG_BLOG_ID
  || BLOG_URL.replace(/\/+$/, '').split('/').filter(Boolean).pop()
  || 'fnt-jany'
).trim();
const MAX_LINK_ITEMS = Math.max(1, Number.parseInt(process.env.NBLOG_MAX_ITEMS || '5000', 10) || 5000);
const PAGE_SIZE = Math.max(1, Number.parseInt(process.env.NBLOG_PAGE_SIZE || '50', 10) || 50);
const CACHE_TTL_MS = Math.max(1000, Number.parseInt(process.env.NBLOG_CACHE_TTL_MS || String(15 * 60 * 1000), 10) || 15 * 60 * 1000);
const REFRESH_INTERVAL_MS = Number.parseInt(process.env.NBLOG_REFRESH_MS || '300000', 10) || 300000;
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'link-cache.json');
const GOOGLE_SITE_VERIFICATION = String(process.env.NBLOG_GOOGLE_SITE_VERIFICATION || '').trim();
const REDIRECT_TARGET = String(process.env.NBLOG_REDIRECT_TARGET || 'mobile').trim().toLowerCase();

let linkCache = null;
let refreshTimer = null;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function safeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function stripHtmlTags(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(text, maxLength) {
  const value = String(text || '').trim();
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function getItemSummary(item) {
  const excerpt = truncateText(stripHtmlTags(item && item.excerpt), 180);
  if (excerpt) {
    return excerpt;
  }

  const category = item && item.category ? `${item.category} 카테고리 글입니다. ` : '';
  const title = item && item.title ? `${item.title}에 대한 네이버 블로그 글입니다. ` : '네이버 블로그 글입니다. ';
  return `${category}${title}본문으로 이동할 수 있는 링크를 제공합니다.`.trim();
}

function formatDateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString();
}

function parseNaverListDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.$/);
  if (!match) {
    return '';
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!year || !month || !day) {
    return '';
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+09:00`;
}

function buildPostViewUrl(blogId, logNo) {
  return `https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`;
}

function buildMobileBlogUrl(blogId, logNo) {
  return `https://m.blog.naver.com/${encodeURIComponent(blogId)}/${encodeURIComponent(logNo)}`;
}

function buildLocalPostUrl(origin, logNo) {
  return `${origin}/post/${encodeURIComponent(logNo)}`;
}

function buildPageUrl(origin, pageNumber) {
  return pageNumber > 1 ? `${origin}/?page=${pageNumber}` : `${origin}/`;
}

function getRedirectUrl(item) {
  if (!item) {
    return '';
  }

  if (REDIRECT_TARGET === 'postview') {
    return item.postViewUrl || item.mobileUrl || item.sourceUrl || '';
  }

  if (REDIRECT_TARGET === 'source') {
    return item.sourceUrl || item.mobileUrl || item.postViewUrl || '';
  }

  return item.mobileUrl || item.sourceUrl || item.postViewUrl || '';
}

function getRelatedItems(data, currentItem, limit = 5) {
  if (!data || !Array.isArray(data.items) || !currentItem) {
    return [];
  }

  const sameCategory = [];
  const fallback = [];
  for (const item of data.items) {
    if (!item || item.logNo === currentItem.logNo) {
      continue;
    }
    if (currentItem.category && item.category === currentItem.category) {
      sameCategory.push(item);
      continue;
    }
    fallback.push(item);
  }

  return sameCategory.concat(fallback).slice(0, limit);
}

function getOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim() || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readPublicFile(filename) {
  return fs.readFileSync(path.join(__dirname, 'public', filename));
}

function readCacheFromDisk() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.blogId !== BLOG_ID || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCacheToDisk(data) {
  ensureDataDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function summarizeCache(cache) {
  const first = cache && cache.items && cache.items[0] ? cache.items[0] : null;
  return {
    count: Array.isArray(cache && cache.items) ? cache.items.length : 0,
    firstLogNo: first ? String(first.logNo || '') : '',
    fetchedAt: Number(cache && cache.fetchedAt) || 0
  };
}

function hydrateCache() {
  if (linkCache) {
    return;
  }
  const diskCache = readCacheFromDisk();
  if (diskCache) {
    linkCache = diskCache;
  }
}

async function fetchPostViewLinks(blogId, options = {}) {
  const normalizedBlogId = String(blogId || '').trim();
  if (!normalizedBlogId) {
    throw new Error('blogId is required');
  }

  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();
  hydrateCache();
  if (!forceRefresh && linkCache && linkCache.blogId === normalizedBlogId && (now - linkCache.fetchedAt) < CACHE_TTL_MS) {
    return linkCache;
  }

  const rssUrl = `https://rss.blog.naver.com/${encodeURIComponent(normalizedBlogId)}.xml`;
  const resp = await fetch(rssUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; NBlogHelper/1.0)'
    }
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch Naver RSS: ${resp.status}`);
  }

  const xml = await resp.text();
  const items = [];
  const seen = new Set();
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml))) {
    const block = match[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
    const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const categoryMatch = block.match(/<category>([\s\S]*?)<\/category>/i);
    const descriptionMatch = block.match(/<description>([\s\S]*?)<\/description>/i);
    const sourceUrl = decodeXmlEntities((guidMatch && guidMatch[1]) || (linkMatch && linkMatch[1]) || '').trim();
    const logNoMatch = sourceUrl.match(/\/(\d+)(?:\?|$)/);
    if (!logNoMatch) {
      continue;
    }

    const logNo = logNoMatch[1];
    if (seen.has(logNo)) {
      continue;
    }
    seen.add(logNo);

    items.push({
      blogId: normalizedBlogId,
      logNo,
      title: decodeXmlEntities((titleMatch && titleMatch[1]) || '').trim() || `Post ${logNo}`,
      category: decodeXmlEntities((categoryMatch && categoryMatch[1]) || '').trim(),
      excerpt: stripHtmlTags(decodeXmlEntities((descriptionMatch && descriptionMatch[1]) || '')).trim(),
      sourceUrl,
      mobileUrl: buildMobileBlogUrl(normalizedBlogId, logNo),
      postViewUrl: buildPostViewUrl(normalizedBlogId, logNo),
      pubDate: decodeXmlEntities((pubDateMatch && pubDateMatch[1]) || '').trim()
    });
  }

  if (items.length < MAX_LINK_ITEMS) {
    let currentPage = 1;
    let totalPages = 1;

    while (items.length < MAX_LINK_ITEMS && currentPage <= totalPages) {
      const listUrl = `https://blog.naver.com/PostTitleListAsync.naver?blogId=${encodeURIComponent(normalizedBlogId)}&viewdate=&currentPage=${currentPage}&categoryNo=0&parentCategoryNo=&countPerPage=50`;
      const listResp = await fetch(listUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; NBlogHelper/1.0)'
        }
      });

      if (!listResp.ok) {
        break;
      }

      const rawPayload = await listResp.text();
      const payload = JSON.parse(rawPayload.replace(/\\'/g, '\''));
      const pageItems = Array.isArray(payload && payload.postList) ? payload.postList : [];
      const totalCount = Number.parseInt(payload && payload.totalCount, 10) || pageItems.length;
      const pageSize = Number.parseInt(payload && payload.countPerPage, 10) || pageItems.length || 1;
      totalPages = Math.max(totalPages, Math.ceil(totalCount / pageSize));

      for (const entry of pageItems) {
        const logNo = String(entry && entry.logNo || '').trim();
        if (!logNo || seen.has(logNo)) {
          continue;
        }

        seen.add(logNo);
        items.push({
          blogId: normalizedBlogId,
          logNo,
          title: decodeURIComponent(String(entry && entry.title || '').replace(/\+/g, ' ')).trim() || `Post ${logNo}`,
          category: '',
          excerpt: '',
          sourceUrl: `https://blog.naver.com/${encodeURIComponent(normalizedBlogId)}/${encodeURIComponent(logNo)}`,
          mobileUrl: buildMobileBlogUrl(normalizedBlogId, logNo),
          postViewUrl: buildPostViewUrl(normalizedBlogId, logNo),
          pubDate: parseNaverListDate(entry && entry.addDate)
        });

        if (items.length >= MAX_LINK_ITEMS) {
          break;
        }
      }

      if (!pageItems.length) {
        break;
      }
      currentPage += 1;
    }
  }

  const nextCache = {
    blogId: normalizedBlogId,
    fetchedAt: now,
    rssUrl,
    items
  };
  linkCache = nextCache;
  writeCacheToDisk(nextCache);
  return nextCache;
}

async function refreshLinksInBackground(reason) {
  try {
    const before = summarizeCache(linkCache || readCacheFromDisk());
    const next = await fetchPostViewLinks(BLOG_ID, { forceRefresh: true });
    const after = summarizeCache(next);
    if (before.count !== after.count || before.firstLogNo !== after.firstLogNo) {
      console.log(`[refresh:${reason}] updated count=${after.count} latest=${after.firstLogNo}`);
    } else {
      console.log(`[refresh:${reason}] checked no-change count=${after.count} latest=${after.firstLogNo}`);
    }
  } catch (error) {
    const message = error && error.message ? error.message : 'unknown error';
    console.error(`[refresh:${reason}] failed ${message}`);
  }
}

function startRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  void refreshLinksInBackground('startup');
  refreshTimer = setInterval(() => {
    void refreshLinksInBackground('interval');
  }, REFRESH_INTERVAL_MS);
}

function renderHtmlPage(data, pageOrigin, pageNumber) {
  const totalItems = data.items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePageNumber = Math.min(Math.max(1, pageNumber || 1), totalPages);
  const startIndex = (safePageNumber - 1) * PAGE_SIZE;
  const pagedItems = data.items.slice(startIndex, startIndex + PAGE_SIZE);
  const canonicalUrl = buildPageUrl(pageOrigin, safePageNumber);
  const sitemapUrl = `${pageOrigin}/sitemap.xml`;
  const pageTitle = safePageNumber > 1
    ? `${data.blogId} 네이버 블로그 글 모음 - ${safePageNumber}페이지`
    : `${data.blogId} 네이버 블로그 글 모음`;
  const pageDescription = `네이버 블로그 ${data.blogId}의 최신 글을 정리한 공개 링크 페이지입니다. 원본 블로그 주소는 ${BLOG_URL} 입니다.`;
  const verificationMeta = GOOGLE_SITE_VERIFICATION
    ? `\n  <meta name="google-site-verification" content="${escapeHtml(GOOGLE_SITE_VERIFICATION)}" />`
    : '';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: pageTitle,
    description: pageDescription,
    url: canonicalUrl,
    isPartOf: {
      '@type': 'WebSite',
      name: 'NBlog Helper',
      url: `${pageOrigin}/`
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: pagedItems.length,
      itemListElement: pagedItems.map((item, index) => ({
        '@type': 'ListItem',
        position: startIndex + index + 1,
        url: buildLocalPostUrl(pageOrigin, item.logNo),
        name: item.title
      }))
    }
  };
  const cards = pagedItems.length
    ? pagedItems.map((item, index) => {
      const badge = item.category ? `<span class="badge">${escapeHtml(item.category)}</span>` : '';
      return `<article class="item">
  <div class="index">${startIndex + index + 1}</div>
  <div class="body">
    <h2><a href="${escapeHtml(buildLocalPostUrl(pageOrigin, item.logNo))}">${escapeHtml(item.title)}</a></h2>
    <div class="meta">
      ${badge}
      <time datetime="${escapeHtml(formatIsoDate(item.pubDate))}">${escapeHtml(formatDateLabel(item.pubDate))}</time>
      <span class="mono">logNo ${escapeHtml(item.logNo)}</span>
    </div>
    <div class="links">
      <a href="${escapeHtml(item.mobileUrl || item.sourceUrl)}" target="_blank" rel="noopener">글 바로가기</a>
      <a href="${escapeHtml(item.postViewUrl)}" target="_blank" rel="noopener">대체 링크</a>
    </div>
  </div>
</article>`;
    }).join('\n')
    : '<p class="empty">표시할 링크가 없습니다.</p>';
  const pagination = totalPages > 1
    ? `<nav class="pagination" aria-label="페이지 이동">
      ${safePageNumber > 1 ? `<a class="page-link" href="${escapeHtml(buildPageUrl(pageOrigin, safePageNumber - 1))}">이전</a>` : '<span class="page-link is-disabled">이전</span>'}
      <span class="page-status">${escapeHtml(String(safePageNumber))} / ${escapeHtml(String(totalPages))}</span>
      ${safePageNumber < totalPages ? `<a class="page-link" href="${escapeHtml(buildPageUrl(pageOrigin, safePageNumber + 1))}">다음</a>` : '<span class="page-link is-disabled">다음</span>'}
    </nav>`
    : '';

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(pageDescription)}" />
  <meta name="robots" content="index,follow" />
${verificationMeta}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="shortcut icon" href="/favicon.svg" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <link rel="sitemap" type="application/xml" href="${escapeHtml(sitemapUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(pageDescription)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta name="twitter:card" content="summary" />
  <style>
    :root {
      --bg: #f4fbff;
      --ink: #0f172a;
      --muted: #475569;
      --line: rgba(15, 23, 42, 0.08);
      --card: rgba(255, 255, 255, 0.88);
      --accent: #075985;
      --accent-soft: #e0f2fe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Noto Sans KR", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, rgba(14, 165, 233, 0.16), transparent 28%),
        radial-gradient(circle at left 20%, rgba(15, 118, 110, 0.14), transparent 24%),
        linear-gradient(180deg, #f5fbff 0%, #eef6fb 100%);
    }
    .shell {
      width: min(960px, calc(100% - 24px));
      margin: 32px auto 56px;
    }
    .hero {
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: linear-gradient(135deg, rgba(255,255,255,0.96), rgba(240,249,255,0.84));
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
    }
    .eyebrow {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 0.8rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    h1 {
      margin: 14px 0 10px;
      font-size: clamp(1.9rem, 4vw, 3rem);
      line-height: 1.08;
    }
    .lead {
      margin: 0;
      color: #334155;
      line-height: 1.6;
    }
    .stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin: 20px 0 0;
      padding: 0;
      list-style: none;
    }
    .stats li {
      min-width: 170px;
      padding: 14px 16px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.72);
    }
    .stats strong,
    .stats span {
      display: block;
    }
    .stats strong {
      font-size: 0.78rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stats span {
      margin-top: 6px;
      font-size: 1rem;
      font-weight: 700;
    }
    .stats a {
      color: var(--accent);
    }
    .list {
      margin-top: 20px;
      display: grid;
      gap: 12px;
    }
    .pagination {
      margin-top: 18px;
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: center;
    }
    .page-link,
    .page-status {
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.84);
    }
    .page-link {
      color: var(--accent);
      text-decoration: none;
    }
    .page-link.is-disabled {
      color: var(--muted);
    }
    .page-status {
      color: var(--ink);
      font-weight: 700;
    }
    .item {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 14px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: var(--card);
      box-shadow: 0 14px 36px rgba(15, 23, 42, 0.05);
    }
    .index {
      width: 40px;
      height: 40px;
      border-radius: 14px;
      background: #082f49;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
    }
    h2 {
      margin: 0;
      font-size: 1.08rem;
      line-height: 1.45;
    }
    h2 a {
      color: inherit;
      text-decoration: none;
    }
    h2 a:hover {
      color: var(--accent);
    }
    .meta, .links {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .meta {
      margin-top: 10px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .badge {
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      font-size: 0.78rem;
    }
    .links {
      margin-top: 12px;
    }
    .links a {
      color: var(--accent);
      text-underline-offset: 2px;
    }
    .mono {
      font-family: Consolas, monospace;
      color: var(--ink);
    }
    .empty {
      padding: 20px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.88);
      color: var(--muted);
    }
    @media (max-width: 640px) {
      .hero { padding: 22px; }
      .item { grid-template-columns: 1fr; }
      .index { width: 36px; height: 36px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <span class="eyebrow">NBlog Helper</span>
      <h1>${escapeHtml(data.blogId)} 글 모음</h1>
      <p class="lead">네이버 블로그 RSS에서 최신 글을 읽어 제목과 링크를 함께 정리한 페이지입니다.</p>
      <ul class="stats">
        <li><strong>블로그 ID</strong><span>${escapeHtml(data.blogId)}</span></li>
        <li><strong>수집 링크 수</strong><span>${escapeHtml(String(totalItems))}</span></li>
        <li><strong>마지막 갱신</strong><span>${escapeHtml(formatDateLabel(data.fetchedAt))}</span></li>
        <li><strong>사이트맵</strong><span><a href="/sitemap.xml">/sitemap.xml</a></span></li>
      </ul>
    </section>
    ${pagination}
    <section class="list">
      ${cards}
    </section>
    ${pagination}
  </main>
  <script type="application/ld+json">${safeJsonForHtml(jsonLd)}</script>
</body>
</html>`;
}

function renderPostPage(item, relatedItems, pageOrigin) {
  const canonicalUrl = item.mobileUrl || item.sourceUrl || item.postViewUrl;
  const pageTitle = `${item.title} | ${item.blogId} 글 링크`;
  const pageDescription = getItemSummary(item);
  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: item.title,
    description: pageDescription,
    datePublished: formatIsoDate(item.pubDate),
    dateModified: formatIsoDate(item.pubDate),
    mainEntityOfPage: canonicalUrl,
    url: canonicalUrl,
    articleSection: item.category || undefined,
    keywords: item.category ? [item.category] : undefined,
    author: {
      '@type': 'Person',
      name: item.blogId
    },
    publisher: {
      '@type': 'Organization',
      name: item.blogId
    },
    isPartOf: {
      '@type': 'Blog',
      name: `${item.blogId} 네이버 블로그`
    }
  };
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'PostView 링크 모음',
        item: `${pageOrigin}/`
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: item.title,
        item: buildLocalPostUrl(pageOrigin, item.logNo)
      }
    ]
  };
  const summary = getItemSummary(item);
  const relatedLinks = relatedItems.length
    ? `<section class="related">
      <h2>관련 글</h2>
      <ul>
        ${relatedItems.map((related) => `<li><a href="${escapeHtml(buildLocalPostUrl(pageOrigin, related.logNo))}">${escapeHtml(related.title)}</a></li>`).join('')}
      </ul>
    </section>`
    : '';
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(pageDescription)}" />
  <meta name="robots" content="noindex,follow" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="shortcut icon" href="/favicon.svg" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${escapeHtml(pageTitle)}" />
  <meta property="og:description" content="${escapeHtml(pageDescription)}" />
  <meta property="og:url" content="${escapeHtml(buildLocalPostUrl(pageOrigin, item.logNo))}" />
  <style>
    body {
      margin: 0;
      font-family: "Noto Sans KR", "Segoe UI", sans-serif;
      color: #0f172a;
      background: linear-gradient(180deg, #f7fbff 0%, #eef6fb 100%);
    }
    main {
      width: min(760px, calc(100% - 24px));
      margin: 40px auto;
      padding: 28px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 24px;
      background: rgba(255,255,255,0.92);
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.08);
    }
    .eyebrow {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: #e0f2fe;
      color: #075985;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    h1 {
      margin: 16px 0 10px;
      font-size: clamp(1.7rem, 4vw, 2.5rem);
      line-height: 1.2;
    }
    p {
      color: #334155;
      line-height: 1.7;
    }
    .meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      color: #475569;
      font-size: 0.92rem;
      margin: 14px 0 20px;
    }
    .links {
      display: grid;
      gap: 12px;
      margin-top: 22px;
    }
    .summary {
      margin: 0;
      color: #334155;
      font-size: 1rem;
    }
    .link-card {
      display: block;
      padding: 16px 18px;
      border-radius: 18px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      background: #fff;
      color: #0f172a;
      text-decoration: none;
    }
    .link-card strong,
    .link-card span {
      display: block;
    }
    .link-card strong {
      font-size: 1rem;
    }
    .link-card span {
      margin-top: 6px;
      color: #475569;
      word-break: break-all;
    }
    .back {
      display: inline-block;
      margin-top: 18px;
      color: #075985;
      text-underline-offset: 2px;
    }
    .related {
      margin-top: 28px;
      padding-top: 22px;
      border-top: 1px solid rgba(15, 23, 42, 0.08);
    }
    .related h2 {
      margin: 0 0 12px;
      font-size: 1.08rem;
    }
    .related ul {
      margin: 0;
      padding-left: 18px;
      color: #334155;
    }
    .related li + li {
      margin-top: 8px;
    }
    .related a {
      color: #075985;
      text-underline-offset: 2px;
    }
  </style>
</head>
<body>
  <main>
    <span class="eyebrow">NBlog Helper</span>
    <h1>${escapeHtml(item.title)}</h1>
    <div class="meta">
      <span>${escapeHtml(formatDateLabel(item.pubDate))}</span>
      <span>logNo ${escapeHtml(item.logNo)}</span>
      ${item.category ? `<span>${escapeHtml(item.category)}</span>` : ''}
    </div>
    <p class="summary">${escapeHtml(summary)}</p>
    <div class="links">
      <a class="link-card" href="${escapeHtml(item.mobileUrl || item.sourceUrl || item.postViewUrl)}" target="_blank" rel="noopener">
        <strong>글 읽기</strong>
        <span>${escapeHtml(item.mobileUrl || item.sourceUrl || item.postViewUrl)}</span>
      </a>
    </div>
    ${relatedLinks}
    <a class="back" href="/">목록으로 돌아가기</a>
  </main>
  <script type="application/ld+json">${safeJsonForHtml(articleJsonLd)}</script>
  <script type="application/ld+json">${safeJsonForHtml(breadcrumbJsonLd)}</script>
</body>
</html>`;
}

function renderXmlSitemap(data, pageOrigin) {
  const rootUrl = `${pageOrigin}/`;
  const urls = [
    `  <url>\n    <loc>${escapeXml(rootUrl)}</loc>\n    <lastmod>${escapeXml(formatIsoDate(data.fetchedAt))}</lastmod>\n  </url>`,
    ...data.items.map((item) => {
      return `  <url>\n    <loc>${escapeXml(buildLocalPostUrl(pageOrigin, item.logNo))}</loc>\n    <lastmod>${escapeXml(formatIsoDate(item.pubDate || data.fetchedAt))}</lastmod>\n  </url>`;
    })
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pageOrigin = getOrigin(req);

  try {
    if (reqUrl.pathname === '/healthz') {
      send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: true }));
      return;
    }

    if (reqUrl.pathname === '/favicon.svg' || reqUrl.pathname === '/favicon.ico') {
      send(res, 200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=86400'
      }, readPublicFile('favicon.svg'));
      return;
    }

    if (reqUrl.pathname === '/robots.txt') {
      send(res, 200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=300'
      }, `User-agent: *\nAllow: /\n\nSitemap: ${pageOrigin}/sitemap.xml\n`);
      return;
    }

    if (reqUrl.pathname === '/crawler-links') {
      send(res, 301, {
        location: `${pageOrigin}/`
      }, '');
      return;
    }

    if (reqUrl.pathname === '/crawler-links.xml') {
      send(res, 301, {
        location: `${pageOrigin}/sitemap.xml`
      }, '');
      return;
    }

    if (reqUrl.pathname === '/sitemap.xml') {
      const data = await fetchPostViewLinks(BLOG_ID);
      send(res, 200, {
        'content-type': 'application/xml; charset=utf-8',
        'x-robots-tag': 'index, follow'
      }, renderXmlSitemap(data, pageOrigin));
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/crawler-links/refresh') {
      const data = await fetchPostViewLinks(BLOG_ID, { forceRefresh: true });
      send(res, 200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }, JSON.stringify({
        ok: true,
        blogId: data.blogId,
        count: data.items.length,
        fetchedAt: data.fetchedAt
      }));
      return;
    }

    if (reqUrl.pathname.startsWith('/post/')) {
      const logNo = reqUrl.pathname.slice('/post/'.length).trim();
      const data = await fetchPostViewLinks(BLOG_ID);
      const item = data.items.find((entry) => entry.logNo === logNo);
      if (!item) {
        send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
        return;
      }
      send(res, 302, {
        location: getRedirectUrl(item),
        'cache-control': 'public, max-age=300',
        'x-robots-tag': 'noindex, follow'
      }, '');
      return;
    }

    if (reqUrl.pathname === '/') {
      const data = await fetchPostViewLinks(BLOG_ID);
      const pageNumber = Math.max(1, Number.parseInt(reqUrl.searchParams.get('page') || '1', 10) || 1);
      send(res, 200, {
        'content-type': 'text/html; charset=utf-8',
        'x-robots-tag': 'index, follow'
      }, renderHtmlPage(data, pageOrigin, pageNumber));
      return;
    }

    send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found');
  } catch (error) {
    const message = error && error.message ? error.message : 'unknown error';
    send(res, 500, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: message }));
  }
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`NBlog helper listening on http://${HOST}:${PORT}`);
  startRefreshLoop();
});
