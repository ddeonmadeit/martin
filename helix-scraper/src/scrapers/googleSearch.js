const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');
const { isJunkDomain } = require('./duckSearch');

function buildQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"${kw}" ${loc} founder contact email`,
    `"${kw}" agency ${loc} about email`,
    `"${kw}" studio ${loc} creative director contact`,
    `"${kw}" ${loc} hire team`,
  ];
}

function buildFallbackQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"performance creative" "${loc}" contact`,
    `"UGC ads" agency "${loc}" email`,
    `"paid social agency" "${loc}" founder`,
    `"creative strategist" "${loc}" contact`,
  ];
}

function extractDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function parseGoogleHtml(html) {
  const $ = cheerio.load(html);
  const urls = [];

  // Google wraps organic result links with /url?q= redirects
  $('a[href^="/url?"], a[href^="https://www.google.com/url"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    try {
      const base = href.startsWith('/') ? 'https://www.google.com' + href : href;
      const parsed = new URL(base);
      const actual = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (actual && actual.startsWith('http') && !actual.includes('google.com')) {
        urls.push(actual);
      }
    } catch {}
  });

  // Fallback: direct links in result containers
  if (urls.length === 0) {
    $('div.g a[href^="http"], .tF2Cxc a[href^="http"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes('google.com') && !href.includes('gstatic.com')) urls.push(href);
    });
  }

  return urls;
}

async function searchGoogle(segment, location, verbose = false) {
  const queries = buildQueries(segment, location);
  const domains = [];

  for (const query of queries) {
    try {
      // Google needs longer delays — be respectful
      await randomDelay(config.SEARCH_DELAY_MIN * 2, config.SEARCH_DELAY_MAX * 3);

      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en&gl=au`;
      const html = await fetchWithRetry(url, {
        sourceKey: 'google.com',
        referer: 'https://www.google.com/'
      });

      if (!html || typeof html !== 'string') continue;

      const urls = parseGoogleHtml(html);
      for (const u of urls) {
        const domain = extractDomainFromUrl(u);
        if (domain && !isJunkDomain(domain) && !domain.includes('google')) {
          domains.push({ website: u, domain, source: 'google' });
        }
      }

      if (verbose) console.log(`  Google: "${query}" — ${domains.length} total`);

    } catch (err) {
      if (verbose) console.log(`  Google Error: "${query}" — ${err.message}`);
    }
  }

  const seen = new Set();
  return domains.filter(d => {
    if (seen.has(d.domain)) return false;
    seen.add(d.domain);
    return true;
  });
}

module.exports = { searchGoogle, buildQueries, buildFallbackQueries };
