import { rankWebsitePages } from './website-relevance.js';

const DEFAULT_TIMEOUT_MS = 6500;
const DEFAULT_MAX_BYTES = 1_500_000;

function isPublicHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || host === '::1' ||
        host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
    return true;
  } catch { return false; }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(value) {
  return decodeEntities(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|nav|footer|header|aside|form|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t\f\v ]+/g, ' ').replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(match?.[1] || '').slice(0, 240);
}

function extractReadableText(html) {
  const source = String(html || '');
  const main = source.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i);
  const body = main?.[1] || source;
  return stripTags(body).slice(0, 18000);
}

function extractInternalLinks(html, baseUrl, origin) {
  const links = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = decodeEntities(match[1] || match[2] || match[3] || '').trim();
    const label = stripTags(match[4] || '').slice(0, 180);
    if (!href || /^(?:#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      url.hash = '';
      if (!isPublicHttpUrl(url.href) || url.origin !== origin) continue;
      if (/\.(?:pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|pptx?)(?:$|\?)/i.test(url.pathname)) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ url: url.href, content: label });
    } catch {}
  }
  return links;
}

async function fetchHtml(url, { timeoutMs, maxBytes }) {
  if (!isPublicHttpUrl(url)) throw new Error('Blocked non-public or unsupported website URL');
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; YemotPublicReader/1.0)',
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'accept-language': 'he-IL,he;q=0.9,en;q=0.7'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!isPublicHttpUrl(response.url || url)) throw new Error('Website redirected to a blocked URL');
  if (!response.ok) throw new Error('Website HTTP ' + response.status);
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml')) {
    throw new Error('Website did not return HTML (' + type.slice(0, 80) + ')');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const html = await response.text();
    if (Buffer.byteLength(html) > maxBytes) throw new Error('Website page exceeded size limit');
    return html;
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Website page exceeded size limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Read a public site's actual HTML and follow a few relevant links on the same host.
 * This is deliberately bounded for IVR latency and never claims to render JavaScript.
 */
export async function readPublicWebsitePages({
  startUrl,
  rootUrl = startUrl,
  question = '',
  searchUrls = [],
  maxPages = 4,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  if (!isPublicHttpUrl(startUrl)) return [];
  const origin = new URL(startUrl).origin;
  const rootOrigin = isPublicHttpUrl(rootUrl) ? new URL(rootUrl).origin : origin;
  if (origin !== rootOrigin) return [];
  const visited = new Set();
  const pages = [];
  const queue = [startUrl];
  for (const candidate of (Array.isArray(searchUrls) ? searchUrls : [])) {
    try { const parsed = new URL(candidate); if (parsed.origin === origin && isPublicHttpUrl(parsed.href)) queue.push(parsed.href); } catch {}
  }
  const enqueue = (url) => {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      if (parsed.origin === origin && isPublicHttpUrl(parsed.href) && !visited.has(parsed.href) && !queue.includes(parsed.href)) queue.push(parsed.href);
    } catch {}
  };
  while (queue.length && pages.length < Math.max(1, Math.min(Number(maxPages) || 4, 6))) {
    const batch = [];
    while (queue.length && batch.length < 3 && pages.length + batch.length < maxPages) {
      const url = queue.shift();
      if (!visited.has(url)) { visited.add(url); batch.push(url); }
    }
    const fetched = await Promise.allSettled(batch.map(async url => {
      const html = await fetchHtml(url, { timeoutMs, maxBytes });
      const finalUrl = new URL(url);
      const text = extractReadableText(html);
      return { url, finalUrl: finalUrl.href, title: extractTitle(html), content: text, links: extractInternalLinks(html, finalUrl.href, origin) };
    }));
    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      const page = result.value;
      if (page.content.length > 80) pages.push({ url: page.url, title: page.title, content: page.content });
      for (const link of page.links) enqueue(link.url);
    }
    // Rank discovered same-site links by URL and anchor text so requested pages
    // such as contact, opening hours, services, pricing and events rise to the top.
    const remaining = queue.map(url => ({ url, content: url })).slice(0, 80);
    const ranked = rankWebsitePages(question, remaining, rootUrl).map(x => x.url);
    queue.splice(0, queue.length, ...ranked);
    if (pages.length >= maxPages) break;
  }
  return rankWebsitePages(question, pages, rootUrl).slice(0, maxPages);
}
