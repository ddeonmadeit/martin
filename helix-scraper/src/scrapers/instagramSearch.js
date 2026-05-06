const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');
const { searchDuckDuckGo } = require('./duckSearch');

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const URL_RE   = /https?:\/\/(?!(?:www\.)?(?:instagram|facebook|twitter|x)\.com)[^\s,<"']+/;

const IG_SKIP = new Set(['p', 'reel', 'tv', 'stories', 'explore', 'accounts', 'legal', 'about', 'help', 'direct']);

function handleFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const h = parts[0];
    return h && !IG_SKIP.has(h) ? h : null;
  } catch { return null; }
}

async function scrapeProfile(profileUrl, verbose = false) {
  try {
    await randomDelay(800, 2000);
    const html = await fetchWithRetry(profileUrl, { sourceKey: 'instagram.com', maxRetries: 0 });
    if (!html) return null;

    const $ = cheerio.load(html);

    // Company name from og:title: "Name (@handle) • Instagram photos and videos"
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const nameMatch = ogTitle.match(/^(.+?)\s*[•·(@]/);
    const companyName = nameMatch ? nameMatch[1].trim() : '';

    // Bio from og:description or embedded JSON
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    let bio = ogDesc.replace(/^\d[\d.,km]* Followers[^-]*[-–]\s*/i, '').trim();

    // Try to get website + full bio from page JSON
    let website = '';
    const extUrlMatch = html.match(/"external_url":"([^"]+)"/);
    if (extUrlMatch) website = extUrlMatch[1].replace(/\\u0026/g, '&').replace(/\\/g, '');

    const bioMatch = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
    if (bioMatch) bio = bioMatch[1].replace(/\\n/g, ' ').replace(/\\u[\da-fA-F]{4}/g, '').trim() || bio;

    // Extract email + website from bio if not found
    const emailMatch = bio.match(EMAIL_RE) || ogDesc.match(EMAIL_RE);
    if (!website) {
      const urlMatch = (bio + ' ' + ogDesc).match(URL_RE);
      if (urlMatch) website = urlMatch[0].replace(/[.,;)>]+$/, '');
    }

    return { companyName, bio, website, directEmail: emailMatch?.[0] || null };
  } catch (err) {
    if (verbose) console.log(`  IG profile error (${profileUrl}): ${err.message}`);
    return null;
  }
}

async function searchInstagram(segment, location, verbose = false) {
  const kw = segment.searchKeywords?.[0] || segment.label;
  const loc = location.label;

  const queries = [
    `site:instagram.com "${kw}" ${loc}`,
    `site:instagram.com "${kw}" agency ${loc}`,
  ];

  const profileUrls = new Map(); // handle → url

  for (const query of queries) {
    try {
      await randomDelay(config.SEARCH_DELAY_MIN, config.SEARCH_DELAY_MAX);
      const stub = { label: query, searchKeywords: [query], slug: 'ig' };
      const results = await searchDuckDuckGo(stub, { slug: '', label: '' }, verbose);
      for (const r of results) {
        const url = r.website || '';
        if (!url.includes('instagram.com/')) continue;
        const handle = handleFromUrl(url);
        if (handle && !profileUrls.has(handle)) {
          profileUrls.set(handle, `https://www.instagram.com/${handle}/`);
        }
      }
    } catch (err) {
      if (verbose) console.log(`  IG search error: ${err.message}`);
    }
  }

  const companies = [];
  for (const [handle, profileUrl] of profileUrls) {
    const data = await scrapeProfile(profileUrl, verbose);

    companies.push({
      website:        data?.website || profileUrl,
      companyName:    data?.companyName || '',
      instagramHandle: '@' + handle,
      instagramUrl:   profileUrl,
      directEmail:    data?.directEmail || null,
      industry:       segment.label,
      location:       location.label,
      source:         'instagram',
    });
  }

  return companies;
}

module.exports = { searchInstagram };
