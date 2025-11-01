const { URL } = require('node:url');

const ALLOWED_HOSTNAMES = new Set(['www.espn.com']);
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;

const cache = new Map();

function log(event, details) {
  console.log(`[espn-page] ${event}`, details);
}

function extractFittPayload(html) {
  const marker = "window['__espnfitt__']";
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Unable to locate ESPN FITT payload.');
  }

  let start = html.indexOf('{', markerIndex);
  if (start === -1) {
    throw new Error('Malformed FITT payload: missing opening brace.');
  }

  let depth = 0;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const end = index + 1;
        const jsonText = html.slice(start, end);
        return JSON.parse(jsonText);
      }
    }
  }

  throw new Error('Malformed FITT payload: missing closing brace.');
}

async function fetchHtmlWithRetry(targetUrl) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'HashmarkChronicles/1.0 (+https://hashmarkchronicles.online)'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new Error(`Upstream request failed with status ${response.status}`);
        error.status = response.status;
        if (retryable && attempt < MAX_RETRIES) {
          lastError = error;
          const backoff = Math.pow(2, attempt - 1) * 250;
          log('retrying-after-status', { targetUrl, attempt, status: response.status, backoff });
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw error;
      }

      const html = await response.text();
      const upstreamCache = response.headers.get('x-cache') || response.headers.get('cf-cache-status');
      return { html, status: response.status, upstreamCache };
    } catch (error) {
      clearTimeout(timeoutId);
      const retryable =
        error.name === 'AbortError' ||
        error.name === 'FetchError' ||
        error.name === 'TypeError' ||
        error.code === 'ECONNRESET' ||
        error.cause?.code === 'ECONNRESET';

      if (retryable && attempt < MAX_RETRIES) {
        lastError = error;
        const backoff = Math.pow(2, attempt - 1) * 250;
        log('retrying-after-network-error', {
          targetUrl,
          attempt,
          message: error.message,
          backoff
        });
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Failed to retrieve upstream HTML');
}

module.exports = async function handler(req, res) {
  const { url: requestedUrl } = req.query;

  if (!requestedUrl) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  let target;
  try {
    target = new URL(requestedUrl);
  } catch (error) {
    res.status(400).json({ error: 'Invalid url parameter' });
    return;
  }

  if (target.protocol !== 'https:') {
    res.status(400).json({ error: 'Only HTTPS endpoints are supported' });
    return;
  }

  if (!ALLOWED_HOSTNAMES.has(target.hostname)) {
    res.status(403).json({ error: 'Hostname not permitted' });
    return;
  }

  const cacheKey = target.toString();
  const cached = cache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    log('cache-hit', { target: cacheKey });
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Proxy-Cache', 'HIT');
    res.setHeader('X-ESPN-Status', String(cached.status));
    if (cached.upstreamCache) {
      res.setHeader('X-ESPN-Cache', cached.upstreamCache);
    }
    res.status(200).send(cached.payload);
    return;
  }

  try {
    log('fetching', { target: cacheKey });
    const { html, status, upstreamCache } = await fetchHtmlWithRetry(cacheKey);
    const payload = JSON.stringify(extractFittPayload(html));
    cache.set(cacheKey, {
      payload,
      expiresAt: now + CACHE_TTL_MS,
      status,
      upstreamCache
    });
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Proxy-Cache', 'MISS');
    res.setHeader('X-ESPN-Status', String(status));
    if (upstreamCache) {
      res.setHeader('X-ESPN-Cache', upstreamCache);
    }
    res.status(200).send(payload);
  } catch (error) {
    log('failure', { target: cacheKey, error: error.message });
    const status = error.status || (error.name === 'AbortError' ? 504 : 502);
    res.status(status).json({ error: 'Unable to fetch ESPN page', details: error.message });
  }
};
