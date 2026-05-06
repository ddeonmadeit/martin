const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');
const { searchDuckDuckGo } = require('./duckSearch');

function extractCompanyWebsite(html) {
  const $ = cheerio.load(html);
  // LinkedIn sometimes puts the website in og:description or page body
  const desc = $('meta[property="og:description"]').attr('content') || '';
  const urlMatch = desc.match(/https?:\/\/(?!(?:www\.)?linkedin\.com)[^\s,<"']+/);
  return urlMatch?.[0]?.replace(/[.,;)>]+$/, '') || '';
}

function extractCompanyName(html) {
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
  return title.replace(/\s*[\|:–-]\s*LinkedIn.*$/i, '').replace(' | LinkedIn', '').trim();
}

async function searchLinkedIn(segment, location, verbose = false) {
  const kw = segment.searchKeywords?.[0] || segment.label;
  const loc = location.label;

  const queries = [
    `site:linkedin.com/company "${kw}" ${loc}`,
    `site:linkedin.com/in "${kw}" ${loc} founder`,
  ];

  const companyUrls = new Set();

  for (const query of queries) {
    try {
      await randomDelay(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX);
      const stub = { label: query, searchKeywords: [query], slug: 'li' };
      const results = await searchDuckDuckGo(stub, { slug: '', label: '' }, verbose);
      for (const r of results) {
        const url = r.website || '';
        if (url.includes('linkedin.com/company/') || url.includes('linkedin.com/in/')) {
          companyUrls.add(url);
        }
      }
    } catch (err) {
      if (verbose) console.log(`  LinkedIn search error: ${err.message}`);
    }
  }

  // Attempt to get company name + website from LinkedIn pages (limited without auth)
  const companies = [];
  for (const companyUrl of companyUrls) {
    try {
      await randomDelay(1000, 2500);
      const html = await fetchWithRetry(companyUrl, { sourceKey: 'linkedin.com', maxRetries: 0 });
      if (!html) continue;

      const companyName = extractCompanyName(html);
      const website     = extractCompanyWebsite(html);

      if (companyName) {
        companies.push({
          website:      website || companyUrl,
          companyName,
          linkedinUrl:  companyUrl,
          industry:     segment.label,
          location:     location.label,
          source:       'linkedin',
        });
      }
    } catch (err) {
      if (verbose) console.log(`  LinkedIn page error: ${err.message}`);
    }
  }

  return companies;
}

module.exports = { searchLinkedIn };
