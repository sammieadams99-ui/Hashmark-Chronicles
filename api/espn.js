const { URL } = require('node:url');

const ALLOWED_HOSTNAMES = new Set([
  'site.api.espn.com',
  'sports.core.api.espn.com'
]);

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;
const cache = new Map();

function log(event, details) {
  console.log(`[espn-proxy] ${event}`, details);
}

async function fetchWithRetry(targetUrl) {
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
          log('retrying after server error', {
            targetUrl,
            attempt,
            status: response.status,
            backoff
          });
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw error;
      }

      const data = await response.json();
      return data;
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
        log('retrying after network error', {
          targetUrl,
          attempt,
          error: error.message,
          backoff
        });
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Failed to retrieve upstream data');
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

  if (!ALLOWED_HOSTNAMES.has(target.hostname)) {
    res.status(403).json({ error: 'Hostname not permitted' });
    return;
  }

  if (target.protocol !== 'https:') {
    res.status(400).json({ error: 'Only HTTPS endpoints are supported' });
    return;
  }

  const cacheKey = target.toString();
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    log('cache hit', { target: cacheKey });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(cached.payload);
    return;
  }

  try {
    log('fetching', { target: cacheKey });
    const data = await fetchWithRetry(cacheKey);
    const payload = JSON.stringify(data);
    cache.set(cacheKey, { payload, expiresAt: now + CACHE_TTL_MS });
    log('success', { target: cacheKey });
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(payload);
  } catch (error) {
    log('failure', { target: cacheKey, error: error.message });
    const status = error.status || (error.name === 'AbortError' ? 504 : 502);
    res.status(status).json({ error: 'Unable to fetch ESPN data', details: error.message });
  }
};
