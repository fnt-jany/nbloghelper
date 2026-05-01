# nbloghelper

`nbloghelper` is a small Node.js server that watches a Naver Blog, builds a crawlable hub page for its posts, and exposes redirect links that can send crawlers or users to the mobile Naver post URL and the `PostView` URL.

The project is intentionally simple:

- no framework
- one main server file
- file-based cache
- HTML rendered directly from the server

## What It Does

- Reads the latest posts from Naver RSS
- Supplements RSS with older posts from `PostTitleListAsync.naver`
- Builds a public index page with pagination
- Exposes a sitemap and robots file
- Redirects `/post/:logNo` to the configured target URL
- Caches fetched results to disk

## Routes

- `/`
  Paginated public hub page
- `/?page=2`
  Next index page
- `/post/:logNo`
  Redirects to the configured target URL
- `/sitemap.xml`
  Sitemap for the hub and post redirect URLs
- `/robots.txt`
  Basic crawl policy with sitemap location
- `/healthz`
  Health check endpoint
- `POST /crawler-links/refresh`
  Forces an immediate refresh

## Environment Variables

Example values live in [`.env.example`](./.env.example).

- `HOST`
  Bind address for the server. Usually `0.0.0.0`.
- `PORT`
  Port to listen on.
- `NBLOG_BLOG_URL`
  Source Naver blog URL.
- `NBLOG_BLOG_ID`
  Source Naver blog ID.
- `NBLOG_MAX_ITEMS`
  Maximum number of items to collect from RSS + Naver post list API.
- `NBLOG_PAGE_SIZE`
  Number of items shown per hub page.
- `NBLOG_CACHE_TTL_MS`
  Cache freshness window in milliseconds.
- `NBLOG_REFRESH_MS`
  Background refresh interval in milliseconds.
- `NBLOG_REDIRECT_TARGET`
  Redirect target for `/post/:logNo`.
  Supported values:
  - `mobile`
  - `postview`
  - `source`
- `NBLOG_GOOGLE_SITE_VERIFICATION`
  Optional Google Search Console verification token.

## Local Run

Install requirements:

- Node.js 18+

Run:

```bash
node server.js
```

Default local address:

```text
http://localhost:3010
```

## Cache

The server stores fetched data in:

```text
data/link-cache.json
```

This file is intentionally excluded from git because it is runtime data.

## Git-ignored Files

The repository excludes:

- `.env`
- `server.log`
- `data/link-cache.json`

## Deployment Notes

This project is currently used behind Cloudflare Tunnel with a separate systemd service on the host machine.

Typical deployment flow:

1. Update `.env`
2. Restart the service
3. Confirm `/healthz`
4. Confirm `/sitemap.xml`
5. Confirm the public hostname

## Current Redirect Behavior

The hub page exposes both:

- mobile Naver post URL
- `PostView` URL

The `/post/:logNo` route redirects to the target selected by `NBLOG_REDIRECT_TARGET`.

## Notes

- Naver RSS alone does not expose the full history
- Older posts are filled in through Naver's post title list API
- The public hub page is paginated to avoid rendering an excessively large list at once
