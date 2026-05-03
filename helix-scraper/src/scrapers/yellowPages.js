const cheerio = require('cheerio');
const config = require('../config');
const { fetchWithRetry, randomDelay } = require('../proxyRotator');

const BASE_URL = 'https://www.yellowpages.com.au';

async function scrapeYellowPages(industrySlug, locationSlug, verbose = false) {
  const companies = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${BASE_URL}/find/${industrySlug}/${locationSlug}` +
      (page > 1 ? `?pageNumber=${page}` : '');

    try {
      await randomDelay(config.DIRECTORY_DELAY_MIN, config.DIRECTORY_DELAY_MAX);
      const html = await fetchWithRetry(url, {
        delayMin: config.DIRECTORY_DELAY_MIN,
        delayMax: config.DIRECTORY_DELAY_MAX,
        sourceKey: 'yellowpages.com.au'
      });

      if (!html || typeof html !== 'string') break;

      const $ = cheerio.load(html);

      // Yellow Pages listing selectors - multiple possible structures
      const listings = $('[class*="listing"]').filter((_, el) => {
        const cls = $(el).attr('class') || '';
        return cls.includes('listing') && !cls.includes('listing-ad');
      });

      // Also try data-listing-id attribute
      const listingsAlt = $('[data-listing-id]');

      const allListings = listings.length > 0 ? listings : listingsAlt;

      if (allListings.length === 0) {
        // Try broader selectors
        const searchResults = $('.search-results .result, .listing-content, .organic-result, li[class*="MuiBox"]');
        if (searchResults.length === 0) {
          hasMore = false;
          break;
        }
        searchResults.each((_, el) => {
          const entry = parseListingElement($, el);
          if (entry) companies.push(entry);
        });
      } else {
        allListings.each((_, el) => {
          const entry = parseListingElement($, el);
          if (entry) companies.push(entry);
        });
      }

      // Check for next page
      const nextLink = $('a[class*="next"], a[aria-label="Next"], .pagination a').filter((_, el) => {
        const text = $(el).text().toLowerCase();
        const ariaLabel = ($(el).attr('aria-label') || '').toLowerCase();
        return text.includes('next') || ariaLabel.includes('next') || text === '›' || text === '»';
      });

      hasMore = nextLink.length > 0 && page < 10;
      page++;

    } catch (err) {
      if (verbose) console.log(`    YP Error: ${industrySlug}/${locationSlug} p${page} — ${err.message}`);
      hasMore = false;
    }
  }

  return companies;
}

function parseListingElement($, el) {
  const $el = $(el);

  // Company name - try multiple selectors
  const name = $el.find('[class*="name"] a, h2 a, h3 a, .listing-name a, a[class*="listing-name"]').first().text().trim() ||
    $el.find('[class*="name"], h2, h3, .listing-name').first().text().trim();

  if (!name) return null;

  // Website URL
  let website = '';
  const websiteLink = $el.find('a[href*="website"], a[class*="website"], a[data-event="website"]');
  if (websiteLink.length > 0) {
    website = websiteLink.attr('href') || '';
    // YP often uses redirect URLs, try to extract the actual URL
    if (website.includes('redirect') || website.includes('yellowpages.com.au')) {
      const dataUrl = websiteLink.attr('data-weburl') || websiteLink.attr('data-url') || '';
      if (dataUrl) website = dataUrl;
    }
  }
  // Also check for external links
  if (!website) {
    $el.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (href.includes('.com.au') && !href.includes('yellowpages')) {
        website = href;
        return false;
      }
    });
  }

  // Phone
  const phone = $el.find('[class*="phone"] a, a[href^="tel:"], .contact-phone').first().text().trim();

  // Address
  const address = $el.find('[class*="address"], .listing-address, .address').first().text().trim();

  // Category
  const category = $el.find('[class*="category"], .listing-category, .categories').first().text().trim();

  // Email (sometimes listed)
  let email = '';
  const emailLink = $el.find('a[href^="mailto:"]');
  if (emailLink.length > 0) {
    email = (emailLink.attr('href') || '').replace('mailto:', '');
  }

  return {
    companyName: name,
    website: website,
    phone: phone,
    address: address,
    category: category,
    email: email,
    source: 'yellowpages'
  };
}

module.exports = { scrapeYellowPages };
