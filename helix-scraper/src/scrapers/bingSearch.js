const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');

function buildQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"${kw}" ${loc} founder contact email`,
    `"${kw}" ${loc} creative director contact`,
    `"${kw}" ${loc} about us team`,
    `"${kw}" agency ${loc} services`
  ];
}

function buildFallbackQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"performance creative" "${loc}" contact`,
    `"UGC ads" agency "${loc}" email`,
    `"paid social agency" "${loc}" founder`,
    `"creative strategist" "${loc}" contact`
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

async function searchBing(segment, location, verbose = false) {
  const queries = buildQueries(segment, location);
  const domains = [];

  for (const query of queries) {
    try {
      await randomDelay(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX);

      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const html = await fetchWithRetry(url, {
        delayMin: config.SEARCH_DELAY_MIN,
        delayMax: config.SEARCH_DELAY_MAX,
        sourceKey: 'bing.com',
        referer: 'https://www.bing.com/'
      });

      if (!html || typeof html !== 'string') continue;

      const $ = cheerio.load(html);

      $('#b_results .b_algo h2 a, #b_results li h2 a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const domain = extractDomainFromUrl(href);
        if (domain && !isJunkDomain(domain)) {
          domains.push({ website: href, domain, source: 'bing' });
        }
      });

      if (verbose) {
        console.log(`  Bing: "${query}" — ${domains.length} domains`);
      }

    } catch (err) {
      if (verbose) console.log(`  Bing Error: "${query}" — ${err.message}`);
    }
  }

  const seen = new Set();
  return domains.filter(d => {
    if (seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { searchBing, buildQueries, buildFallbackQueries };
