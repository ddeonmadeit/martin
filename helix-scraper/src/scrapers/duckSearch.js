const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');

function buildQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"${kw}" ${loc} founder contact email`,
    `"${kw}" ${loc} "creative director" OR "head of production" contact`,
    `"${kw}" ${loc} about us`,
    `"${kw}" agency ${loc} team`
  ];
}

function buildFallbackQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"performance creative" "${loc}" contact`,
    `"UGC ads" agency "${loc}" email`,
    `"paid social agency" "${loc}" founder`,
    `"creative strategist" "${loc}" freelance contact`
  ];
}

function isJunkDomain(domain) {
  const lower = domain.toLowerCase();
  for (const junk of config.JUNK_DOMAINS) {
    if (lower === junk || lower.endsWith('.' + junk)) return true;
  }
  if (lower.endsWith('.gov') || lower.endsWith('.gov.au') || lower.endsWith('.edu')) return true;
  return false;
}

function extractDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function searchDuckDuckGo(segment, location, verbose = false) {
  const queries = buildQueries(segment, location);
  const domains = [];

  for (const query of queries) {
    try {
      await randomDelay(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX);

      const html = await fetchWithRetry('https://html.duckduckgo.com/html/', {
        delayMin: config.SEARCH_DELAY_MIN,
        delayMax: config.SEARCH_DELAY_MAX,
        sourceKey: 'duckduckgo.com',
        method: 'POST',
        postData: `q=${encodeURIComponent(query)}`,
        referer: 'https://html.duckduckgo.com/'
      });

      if (!html || typeof html !== 'string') continue;

      const $ = cheerio.load(html);

      $('a.result__a').each((_, el) => {
        const href = $(el).attr('href') || '';
        let actualUrl = href;

        if (href.includes('uddg=')) {
          try {
            const parsed = new URL(href, 'https://duckduckgo.com');
            actualUrl = decodeURIComponent(parsed.searchParams.get('uddg') || href);
          } catch {}
        }

        const domain = extractDomainFromUrl(actualUrl);
        if (domain && !isJunkDomain(domain)) {
          domains.push({ website: actualUrl, domain, source: 'duckduckgo' });
        }
      });

      if (verbose) {
        console.log(`  DDG: "${query}" — ${domains.length} domains`);
      }

    } catch (err) {
      if (verbose) console.log(`  DDG Error: "${query}" — ${err.message}`);
    }
  }

  const seen = new Set();
  return domains.filter(d => {
    if (seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { searchDuckDuckGo, buildQueries, buildFallbackQueries };
