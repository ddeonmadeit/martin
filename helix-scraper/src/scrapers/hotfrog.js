const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');

const BASE_URL = 'https://www.hotfrog.com.au';

async function scrapeHotfrog(industrySlug, locationSlug, verbose = false) {
  const companies = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    // Hotfrog URL pattern: /search/{location}/{industry}
    const url = `${BASE_URL}/search/${locationSlug}/${industrySlug}` +
      (page > 1 ? `?page=${page}` : '');

    try {
      await randomDelay(config.DIRECTORY_DELAY_MIN, config.DIRECTORY_DELAY_MAX);
      const html = await fetchWithRetry(url, {
        delayMin: config.DIRECTORY_DELAY_MIN,
        delayMax: config.DIRECTORY_DELAY_MAX,
        sourceKey: 'hotfrog.com.au'
      });

      if (!html || typeof html !== 'string') break;

      const $ = cheerio.load(html);
      let found = 0;

      // Hotfrog listing selectors
      const listings = $('[class*="result"], [class*="listing"], .business-card, article, .search-result');

      if (listings.length === 0) {
        hasMore = false;
        break;
      }

      listings.each((_, el) => {
        const $el = $(el);

        const name = $el.find('h2 a, h3 a, [class*="name"] a, .business-name').first().text().trim() ||
          $el.find('h2, h3, [class*="name"]').first().text().trim();

        if (!name) return;

        let website = '';
        const websiteLink = $el.find('a[class*="website"], a[rel="nofollow"]');
        if (websiteLink.length > 0) {
          const href = websiteLink.attr('href') || '';
          if (!href.includes('hotfrog.com.au')) {
            website = href;
          }
        }
        if (!website) {
          $el.find('a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            if (href.includes('.com.au') && !href.includes('hotfrog')) {
              website = href;
              return false;
            }
          });
        }

        const phone = $el.find('a[href^="tel:"], [class*="phone"]').first().text().trim();
        const address = $el.find('[class*="address"], .location').first().text().trim();

        let email = '';
        const emailLink = $el.find('a[href^="mailto:"]');
        if (emailLink.length > 0) {
          email = (emailLink.attr('href') || '').replace('mailto:', '');
        }

        companies.push({
          companyName: name,
          website,
          phone,
          address,
          category: industrySlug,
          email,
          source: 'hotfrog'
        });
        found++;
      });

      const nextLink = $('a[class*="next"], a[rel="next"], .pagination .next');
      hasMore = nextLink.length > 0 && page < 10 && found > 0;
      page++;

    } catch (err) {
      if (verbose) console.log(`    HF Error: ${industrySlug}/${locationSlug} p${page} — ${err.message}`);
      hasMore = false;
    }
  }

  return companies;
}

module.exports = { scrapeHotfrog };
