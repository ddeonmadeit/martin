const axios = require('axios');
const path = require('path');
const config = require('./config');

const userAgents = require(path.join(config.DATA_DIR, 'userAgents.json'));

const acceptLanguages = ['en-AU,en;q=0.9', 'en-US,en;q=0.9', 'en-GB,en;q=0.9'];

const blockTracker = {};

function getRandomUA() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getRandomAcceptLang() {
  return acceptLanguages[Math.floor(Math.random() * acceptLanguages.length)];
}

function getHeaders(referer) {
  const headers = {
    'User-Agent': getRandomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': getRandomAcceptLang(),
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  };
  if (referer) {
    headers['Referer'] = referer;
    headers['Sec-Fetch-Site'] = 'same-origin';
  }
  return headers;
}

function randomDelay(min, max) {
  const delay = min + Math.random() * (max - min);
  return new Promise(resolve => setTimeout(resolve, delay));
}

function getSourceKey(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname;
  } catch {
    return url;
  }
}

function recordBlock(sourceKey) {
  if (!blockTracker[sourceKey]) {
    blockTracker[sourceKey] = { count: 0, pausedUntil: 0 };
  }
  blockTracker[sourceKey].count++;
  if (blockTracker[sourceKey].count >= config.MAX_CONSECUTIVE_BLOCKS) {
    blockTracker[sourceKey].pausedUntil = Date.now() + config.BLOCK_LONG_PAUSE_MS;
    blockTracker[sourceKey].count = 0;
    return config.BLOCK_LONG_PAUSE_MS;
  }
  blockTracker[sourceKey].pausedUntil = Date.now() + config.BLOCK_PAUSE_MS;
  return config.BLOCK_PAUSE_MS;
}

function clearBlock(sourceKey) {
  if (blockTracker[sourceKey]) {
    blockTracker[sourceKey].count = 0;
  }
}

function isSourcePaused(sourceKey) {
  const tracker = blockTracker[sourceKey];
  if (!tracker) return false;
  return Date.now() < tracker.pausedUntil;
}

async function fetchWithRetry(url, options = {}) {
  const {
    delayMin = config.SITE_DELAY_MIN,
    delayMax = config.SITE_DELAY_MAX,
    maxRetries = config.MAX_RETRIES,
    sourceKey = null,
    method = 'GET',
    postData = null,
    referer = null
  } = options;

  const key = sourceKey || getSourceKey(url);

  if (isSourcePaused(key)) {
    const waitTime = blockTracker[key].pausedUntil - Date.now();
    if (waitTime > 60000) {
      throw new Error(`Source ${key} is paused for ${Math.round(waitTime / 1000)}s`);
    }
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, config.RETRY_BACKOFF_BASE * attempt)
        );
      }

      const axiosConfig = {
        headers: getHeaders(referer),
        timeout: config.REQUEST_TIMEOUT,
        maxRedirects: 10,
        validateStatus: (status) => status < 500
      };

      let response;
      if (method === 'POST' && postData) {
        axiosConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        response = await axios.post(url, postData, axiosConfig);
      } else {
        response = await axios.get(url, axiosConfig);
      }

      if (response.status === 403 || response.status === 429) {
        const pauseMs = recordBlock(key);
        throw new Error(`Blocked (${response.status}) from ${key}, pausing ${pauseMs / 1000}s`);
      }

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      clearBlock(key);
      return response.data;
    } catch (err) {
      if (attempt === maxRetries) {
        throw err;
      }
    }
  }
}

module.exports = {
  fetchWithRetry,
  randomDelay,
  getHeaders,
  getRandomUA,
  isSourcePaused,
  recordBlock,
  clearBlock
};
