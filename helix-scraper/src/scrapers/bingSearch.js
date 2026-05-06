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
    `"${kw}" agency ${loc} services`,
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

function parseBingHtml(html) {
  const $ = cheerio.load(html);
  const urls = [];

  // Primary: standard Bing result structure
  $('#b_results .b_algo, #b_results > li.b_algo').each((_, item) => {
    const $item = $(item);

    // h2 > a is the main result link
    const linkEl = $item.find('h2 a').first();
    let href = linkEl.attr('href') || '';

    // Bing sometimes uses /ck/a? tracking redirects — try data-u or cite as fallback
    if (!href || href.includes('/ck/a?') || !href.startsWith('http')) {
      const dataU = linkEl.attr('data-u') || '';
      if (dataU.startsWith('http')) {
        href = dataU;
      } else {
        // Extract from cite element (shows readable domain)
        const citeText = $item.find('cite').first().text().trim();
        const cleanPart = citeText.split('›')[0].trim().split(' ')[0];
        if (cleanPart && cleanPart.includes('.') && !cleanPart.includes('bing') && !cleanPart.includes('microsoft')) {
          href = cleanPart.startsWith('http') ? cleanPart : 'https://' + cleanPart;
        }
      }
    }

    if (href && href.startsWith('http') && !href.includes('bing.com') && !href.includes('microsoft.com')) {
      urls.push(href);
    }
  });

  // Fallback 1: any h2 link that looks like an external URL
  if (urls.length === 0) {
    $('h2 a[href^="http"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes('bing.com') && !href.includes('microsoft.com')) urls.push(href);
    });
  }

  // Fallback 2: cite elements
  if (urls.length === 0) {
    $('cite').each((_, el) => {
      const text = $(el).text().trim().split('›')[0].trim().split(' ')[0];
      if (text && text.includes('.') && !text.includes('bing') && !text.includes('microsoft')) {
        urls.push('https://' + text);
      }
    });
  }

  return urls;
}

async function searchBing(segment, location, verbose = false) {
  const queries = buildQueries(segment, location);
  const domains = [];

  for (const query of queries) {
    try {
      await randomDelay(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX);

      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20`;
      const html = await fetchWithRetry(url, {
        sourceKey: 'bing.com',
        referer: 'https://www.bing.com/'
      });

      if (!html || typeof html !== 'string') continue;

      const urls = parseBingHtml(html);
      for (const u of urls) {
        const domain = extractDomainFromUrl(u);
        if (domain && !isJunkDomain(domain)) {
          domains.push({ website: u, domain, source: 'bing' });
        }
      }

      if (verbose) console.log(`  Bing: "${query}" — ${domains.length} total`);

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
