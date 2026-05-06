const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');

function buildQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"${kw}" ${loc} founder email contact`,
    `"${kw}" ${loc} "creative director" OR "head of production" site`,
    `"${kw}" agency ${loc} about`,
    `"${kw}" studio ${loc} team`,
  ];
}

function buildFallbackQueries(segment, location) {
  const kw = segment.searchKeywords ? segment.searchKeywords[0] : segment.label;
  const loc = location.label;
  return [
    `"performance creative" "${loc}" contact`,
    `"UGC ads" agency "${loc}" email`,
    `"paid social agency" "${loc}" founder`,
    `"creative strategist" "${loc}" freelance contact`,
  ];
}

function isJunkDomain(domain, allowGov = false) {
  const lower = domain.toLowerCase();
  for (const junk of config.JUNK_DOMAINS) {
    if (lower === junk || lower.endsWith('.' + junk)) return true;
  }
  if (!allowGov && (lower.endsWith('.gov') || lower.endsWith('.gov.au') || lower.endsWith('.gov.nz'))) return true;
  if (lower.endsWith('.edu') || lower.endsWith('.edu.au')) return true;
  return false;
}

function extractDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function resolveHref(href) {
  if (!href) return null;
  // Handle DDG redirect: ?uddg=<encoded-url>
  if (href.includes('uddg=')) {
    try {
      const base = href.startsWith('http') ? href : 'https://duckduckgo.com' + href;
      const uddg = new URL(base).searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    } catch {}
  }
  if (href.startsWith('http')) return href;
  return null;
}

function parseLinks(html) {
  const $ = cheerio.load(html);
  const hrefs = [];

  // Primary: standard DDG result anchor
  $('a.result__a').each((_, el) => hrefs.push($(el).attr('href') || ''));

  // Fallback 1: any anchor with uddg= parameter
  if (hrefs.length === 0) {
    $('a[href*="uddg="]').each((_, el) => hrefs.push($(el).attr('href') || ''));
  }

  // Fallback 2: h2 links that aren't DDG internal
  if (hrefs.length === 0) {
    $('h2 a, .results a').each((_, el) => {
      const h = $(el).attr('href') || '';
      if (h.startsWith('http') && !h.includes('duckduckgo.com')) hrefs.push(h);
    });
  }

  return hrefs;
}

async function searchDuckDuckGo(segment, location, verbose = false) {
  const queries = buildQueries(segment, location);
  const domains = [];

  for (const query of queries) {
    try {
      await randomDelay(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX);

      let html = null;
      // Try POST (standard DDG HTML endpoint)
      try {
        html = await fetchWithRetry('https://html.duckduckgo.com/html/', {
          sourceKey: 'duckduckgo.com',
          method: 'POST',
          postData: `q=${encodeURIComponent(query)}&kl=en-us`,
          referer: 'https://html.duckduckgo.com/'
        });
      } catch {
        // Fallback to GET
        html = await fetchWithRetry(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          { sourceKey: 'duckduckgo.com', referer: 'https://duckduckgo.com/' }
        );
      }

      if (!html || typeof html !== 'string') continue;

      const hrefs = parseLinks(html);
      for (const href of hrefs) {
        const url = resolveHref(href);
        if (!url) continue;
        const domain = extractDomainFromUrl(url);
        if (domain && !isJunkDomain(domain) && !domain.includes('duckduckgo')) {
          domains.push({ website: url, domain, source: 'duckduckgo' });
        }
      }

      if (verbose) console.log(`  DDG: "${query}" — ${domains.length} total`);

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

module.exports = { searchDuckDuckGo, buildQueries, buildFallbackQueries, isJunkDomain };
