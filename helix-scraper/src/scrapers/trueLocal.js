const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');

const BASE_URL = 'https://www.truelocal.com.au';

async function scrapeTrueLocal(industrySlug, locationSlug, verbose = false) {
  const companies = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${BASE_URL}/find/${industrySlug}/${locationSlug}` +
      (page > 1 ? `/page-${page}` : '');

    try {
      await randomDelay(config.DIRECTORY_DELAY_MIN, config.DIRECTORY_DELAY_MAX);
      const html = await fetchWithRetry(url, {
        delayMin: config.DIRECTORY_DELAY_MIN,
        delayMax: config.DIRECTORY_DELAY_MAX,
        sourceKey: 'truelocal.com.au'
      });

      if (!html || typeof html !== 'string') break;

      const $ = cheerio.load(html);
      let found = 0;

      // TrueLocal listing selectors
      const listings = $('[class*="search-result"], [class*="listing"], .result-item, article');

      if (listings.length === 0) {
        hasMore = false;
        break;
      }

      listings.each((_, el) => {
        const $el = $(el);

        const name = $el.find('h2 a, h3 a, [class*="name"] a, .business-name a').first().text().trim() ||
          $el.find('h2, h3, [class*="name"], .business-name').first().text().trim();

        if (!name) return;

        let website = '';
        const websiteLink = $el.find('a[class*="website"], a[data-type="website"]');
        if (websiteLink.length > 0) {
          website = websiteLink.attr('href') || '';
        }
        if (!website) {
          $el.find('a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            if (href.includes('.com.au') && !href.includes('truelocal')) {
              website = href;
              return false;
            }
          });
        }

        const phone = $el.find('a[href^="tel:"], [class*="phone"]').first().text().trim();
        const address = $el.find('[class*="address"], .location').first().text().trim();
        const category = $el.find('[class*="category"]').first().text().trim();

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
          category,
          email,
          source: 'truelocal'
        });
        found++;
      });

      // Pagination
      const nextLink = $('a[class*="next"], a[rel="next"], .pagination .next');
      hasMore = nextLink.length > 0 && page < 10 && found > 0;
      page++;

    } catch (err) {
      if (verbose) console.log(`    TL Error: ${industrySlug}/${locationSlug} p${page} — ${err.message}`);
      hasMore = false;
    }
  }

  return companies;
}

module.exports = { scrapeTrueLocal };
