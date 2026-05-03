const cheerio = require('cheerio');
const config = require('./config');
const { fetchWithRetry, randomDelay } = require('./proxyRotator');
const { classifyEmail, isFreeDomain, scoreLead, detectICPSignal, detectAntiICP, detectBuyerTitle } = require('./qualityScorer');
const pLimit = require('p-limit');

const EMAIL_REGEX_GLOBAL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_REGEX_TEST = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const OBFUSCATED_REGEX = /[a-zA-Z0-9._%+-]+\s*[(\[]?\s*(?:at|AT)\s*[)\]]?\s*[a-zA-Z0-9.-]+\s*[(\[]?\s*(?:dot|DOT)\s*[)\]]?\s*[a-zA-Z]{2,}/g;
const NAME_REGEX = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;

function extractEmails(html) {
  const emails = new Set();

  // Standard email regex
  const matches = html.match(EMAIL_REGEX_GLOBAL) || [];
  matches.forEach(e => emails.add(e.toLowerCase()));

  // Mailto links
  const mailtoMatches = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi) || [];
  mailtoMatches.forEach(m => {
    const email = m.replace(/^mailto:/i, '').toLowerCase();
    emails.add(email);
  });

  // Obfuscated emails
  const obfuscated = html.match(OBFUSCATED_REGEX) || [];
  obfuscated.forEach(o => {
    const cleaned = o.replace(/\s*[(\[]?\s*(?:at|AT)\s*[)\]]?\s*/g, '@').replace(/\s*[(\[]?\s*(?:dot|DOT)\s*[)\]]?\s*/g, '.');
    if (cleaned && EMAIL_REGEX_TEST.test(cleaned)) {
      emails.add(cleaned.toLowerCase());
    }
  });

  return [...emails];
}

function filterEmails(emails) {
  return emails.filter(email => {
    // Remove free domain emails
    if (isFreeDomain(email)) return false;

    // Remove automated emails
    const local = email.split('@')[0].toLowerCase();
    for (const prefix of config.AUTOMATED_PREFIXES) {
      if (local === prefix || local.startsWith(prefix + '.') || local.startsWith(prefix + '-')) {
        return false;
      }
    }

    // Basic validation
    if (email.length < 5 || email.length > 100) return false;
    if (email.includes('..') || email.startsWith('.') || email.endsWith('.')) return false;

    // Skip image filenames that look like emails
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(email)) return false;

    return true;
  });
}

function extractOwnerName(html, $) {
  const text = $ ? $.text() : html.replace(/<[^>]+>/g, ' ');

  for (const keyword of config.OWNER_KEYWORDS) {
    const regex = new RegExp(keyword + '[:\\s,\\-]+', 'i');
    const idx = text.toLowerCase().indexOf(keyword);
    if (idx === -1) continue;

    const surrounding = text.substring(idx, idx + 150);
    const nameMatches = surrounding.match(NAME_REGEX);
    if (nameMatches && nameMatches.length > 0) {
      // Filter out common false positives
      const name = nameMatches[0];
      const falsePositives = ['Read More', 'Learn More', 'Click Here', 'Find Out',
        'Contact Us', 'About Us', 'Our Team', 'Get Quote', 'Free Quote'];
      if (!falsePositives.includes(name)) {
        return name;
      }
    }
  }

  // Check meta author
  if ($) {
    const author = $('meta[name="author"]').attr('content');
    if (author && /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/.test(author)) {
      return author.trim();
    }

    // Check JSON-LD
    let jsonLdName = '';
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdName) return false; // break
      try {
        const data = JSON.parse($(el).html());
        if (data['@type'] === 'Person' && data.name) {
          jsonLdName = data.name;
        } else if (data.founder && data.founder.name) {
          jsonLdName = data.founder.name;
        }
      } catch {}
    });
    if (jsonLdName) return jsonLdName;
  }

  return '';
}

function extractCompanyName($, url) {
  if (!$) return '';

  // og:site_name
  const ogName = $('meta[property="og:site_name"]').attr('content');
  if (ogName) return ogName.trim();

  // title tag
  const title = $('title').text();
  if (title) {
    // Clean common suffixes
    return title.split(/\s*[|\-–—]\s*/)[0].trim();
  }

  // h1
  const h1 = $('h1').first().text();
  if (h1) return h1.trim();

  return '';
}

async function scrapeSite(company, verbose = false) {
  const { website, companyName: dirCompanyName, industry, location, source } = company;

  if (!website) return null;

  let baseUrl = website;
  if (!baseUrl.startsWith('http')) {
    baseUrl = 'https://' + baseUrl;
  }
  // Remove trailing slash
  baseUrl = baseUrl.replace(/\/+$/, '');

  const allEmails = [];
  let allHtml = '';
  let $home = null;
  let ownerName = '';
  let siteName = dirCompanyName || '';

  // Fetch homepage
  try {
    const html = await fetchWithRetry(baseUrl, {
      delayMin: config.SITE_DELAY_MIN,
      delayMax: config.SITE_DELAY_MAX
    });
    if (html && typeof html === 'string') {
      allHtml += html;
      $home = cheerio.load(html);
      allEmails.push(...extractEmails(html));
      ownerName = extractOwnerName(html, $home);
      if (!siteName) siteName = extractCompanyName($home, baseUrl);
    }
  } catch (err) {
    if (verbose) console.log(`    Error fetching ${baseUrl}: ${err.message}`);
  }

  // If homepage already yielded emails, only hit 2 quick subpages instead of all 10
  const subpages = allEmails.length > 0 ? config.CONTACT_SUBPAGES_QUICK : config.CONTACT_SUBPAGES;

  // Fetch subpages in parallel (limited)
  const limit = pLimit(3);
  const subpagePromises = subpages.map(subpage =>
    limit(async () => {
      try {
        const url = baseUrl + subpage;
        const html = await fetchWithRetry(url, {
          delayMin: config.SITE_DELAY_MIN,
          delayMax: config.SITE_DELAY_MAX,
          maxRetries: 0
        });
        if (html && typeof html === 'string') {
          allHtml += html;
          allEmails.push(...extractEmails(html));
          if (!ownerName) {
            const $ = cheerio.load(html);
            ownerName = extractOwnerName(html, $);
          }
        }
      } catch {}
    })
  );

  await Promise.all(subpagePromises);

  // Filter and deduplicate emails
  const filteredEmails = filterEmails([...new Set(allEmails)]);

  if (filteredEmails.length === 0) return null;

  // Pick the best email: prefer personal over generic
  let bestEmail = filteredEmails[0];
  let bestType = classifyEmail(bestEmail);

  for (const email of filteredEmails) {
    const type = classifyEmail(email);
    if (type === 'personal' && bestType !== 'personal') {
      bestEmail = email;
      bestType = type;
      break;
    }
  }

  const emailType = classifyEmail(bestEmail);
  const isICPSignal = detectICPSignal(allHtml);
  const isAntiICP = detectAntiICP(allHtml);
  const hasBuyerTitle = detectBuyerTitle(allHtml);

  const lead = {
    email: bestEmail,
    ownerName: ownerName || '',
    companyName: siteName || '',
    website: baseUrl,
    industry: industry || '',
    location: location || '',
    emailType,
    isICPSignal,
    isAntiICP,
    hasBuyerTitle,
    source: source || '',
    qualityScore: 0
  };

  lead.qualityScore = scoreLead(lead);

  return lead;
}

module.exports = { scrapeSite, extractEmails, filterEmails };
