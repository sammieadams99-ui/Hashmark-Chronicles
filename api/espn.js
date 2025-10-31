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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  return (
    error.name === 'AbortError' ||
    error.name === 'FetchError' ||
    error.name === 'TypeError' ||
    error.code === 'ECONNRESET' ||
    error.cause?.code === 'ECONNRESET'
  );
}

function summarizeBody(data) {
  try {
    const json = JSON.stringify(data);
    return json.length > 180 ? `${json.slice(0, 177)}…` : json;
  } catch (error) {
    return '[unserializable payload]';
  }
}

function countRecords(data) {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  if (Array.isArray(data)) {
    return data.length;
  }

  if (Array.isArray(data.events)) {
    return data.events.length;
  }

  if (Array.isArray(data.items)) {
    return data.items.length;
  }

  if (Array.isArray(data.athletes)) {
    return data.athletes.length;
  }

  return undefined;
}

async function fetchWithRetry(targetUrl) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const start = Date.now();

    try {
      log('attempt', { targetUrl, attempt });
      const response = await fetch(targetUrl, { signal: controller.signal });
      const durationMs = Date.now() - start;
      clearTimeout(timeoutId);

      const rawBody = await response.text();
      let parsed;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : null;
      } catch (parseError) {
        const error = new Error('Upstream response was not valid JSON');
        error.status = response.status;
        error.preview = rawBody.slice(0, 200);
        error.durationMs = durationMs;
        throw error;
      }

      const preview = summarizeBody(parsed);
      const recordCount = countRecords(parsed);

      if (!response.ok) {
        const error = new Error(`Upstream request failed with status ${response.status}`);
        error.status = response.status;
        error.preview = preview;
        error.durationMs = durationMs;

        const retryable = shouldRetryStatus(response.status);
        log('upstream error', {
          targetUrl,
          attempt,
          status: response.status,
          durationMs,
          preview
        });

        if (retryable && attempt < MAX_RETRIES) {
          lastError = error;
          const backoff = Math.pow(2, attempt - 1) * 300;
          log('retrying', { targetUrl, attempt, backoff });
          await sleep(backoff);
          continue;
        }

        throw error;
      }

      log('upstream success', {
        targetUrl,
        attempt,
        status: response.status,
        durationMs,
        preview,
        recordCount
      });

      return {
        data: parsed,
        info: { status: response.status, durationMs, preview, recordCount }
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const durationMs = Date.now() - start;
      const retryable = isRetryableError(error);
      log('upstream failure', {
        targetUrl,
        attempt,
        durationMs,
        error: error.message,
        status: error.status,
        preview: error.preview
      });

      if ((retryable || shouldRetryStatus(error.status)) && attempt < MAX_RETRIES) {
        lastError = error;
        const backoff = Math.pow(2, attempt - 1) * 300;
        await sleep(backoff);
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
    log('cache hit', {
      target: cacheKey,
      recordCount: cached.info?.recordCount,
      ageMs: cached.fetchedAt ? now - cached.fetchedAt : undefined
    });
    setResponseMetadata(res, cached.info, 'HIT');
    res.status(200).send(cached.payload);
    return;
  }

  try {
    log('fetching', { target: cacheKey });
    const { data, info } = await fetchWithRetry(cacheKey);
    const payload = JSON.stringify(data);
    cache.set(cacheKey, {
      payload,
      info,
      fetchedAt: now,
      expiresAt: now + CACHE_TTL_MS
    });
    log('success', {
      target: cacheKey,
      status: info.status,
      durationMs: info.durationMs,
      recordCount: info.recordCount
    });
    setResponseMetadata(res, info, 'MISS');
    res.status(200).send(payload);
  } catch (error) {
    log('failure', { target: cacheKey, error: error.message, status: error.status });
    const status = error.status || (error.name === 'AbortError' ? 504 : 502);
    res.status(status).json({ error: 'Unable to fetch ESPN data', details: error.message, preview: error.preview });
  }
};

function setResponseMetadata(res, info = {}, cacheState) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('x-espn-cache', cacheState || 'MISS');
  if (typeof info.durationMs === 'number') {
    res.setHeader('x-espn-duration-ms', String(Math.round(info.durationMs)));
  }
  if (typeof info.recordCount === 'number') {
    res.setHeader('x-espn-records', String(info.recordCount));
  }
}

module.exports.config = {
  runtime: 'nodejs18.x'
};
