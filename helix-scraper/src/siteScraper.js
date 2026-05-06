const cheerio = require('cheerio');
const config = require('./config');
const { fetchWithRetry, randomDelay } = require('./proxyRotator');
const { classifyEmail, isFreeDomain, scoreLead, detectICPSignal, detectAntiICP, detectBuyerTitle } = require('./qualityScorer');
const pLimit = require('p-limit');

const EMAIL_REGEX_GLOBAL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_REGEX_TEST   = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const OBFUSCATED_REGEX   = /[a-zA-Z0-9._%+-]+\s*[(\[]?\s*(?:at|AT)\s*[)\]]?\s*[a-zA-Z0-9.-]+\s*[(\[]?\s*(?:dot|DOT)\s*[)\]]?\s*[a-zA-Z]{2,}/g;
const NAME_REGEX         = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;

// Phone: Australian, NZ, UK, US, and generic international formats
const PHONE_REGEX = /(?:\+?61|0)[\s\-.]?[2-9][\s\-.]?\d{4}[\s\-.]?\d{4}|(?:\+?64|0)[\s\-.]?[2-9][\d\s\-\.]{6,9}|\+[\d]{1,3}[\s\-.][\d\s\-\.]{6,14}|(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g;

// Instagram handle from URL or text
const IG_URL_REGEX = /instagram\.com\/([a-zA-Z0-9_.]{1,30})(?:\/|\?|$)/g;
const IG_HANDLE_REGEX = /(?:^|[\s,;\("])@([a-zA-Z0-9_.]{2,30})(?:\s|$|[,;.\)])/g;

const IG_SKIP = new Set(['p', 'reel', 'tv', 'stories', 'explore', 'accounts', 'legal', 'about', 'help', 'direct']);

function extractEmails(html) {
  const emails = new Set();

  (html.match(EMAIL_REGEX_GLOBAL) || []).forEach(e => emails.add(e.toLowerCase()));

  (html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi) || []).forEach(m =>
    emails.add(m.replace(/^mailto:/i, '').toLowerCase())
  );

  (html.match(OBFUSCATED_REGEX) || []).forEach(o => {
    const cleaned = o
      .replace(/\s*[(\[]?\s*(?:at|AT)\s*[)\]]?\s*/g, '@')
      .replace(/\s*[(\[]?\s*(?:dot|DOT)\s*[)\]]?\s*/g, '.');
    if (EMAIL_REGEX_TEST.test(cleaned)) emails.add(cleaned.toLowerCase());
  });

  return [...emails];
}

function filterEmails(emails) {
  return emails.filter(email => {
    if (isFreeDomain(email)) return false;
    const local = email.split('@')[0].toLowerCase();
    for (const p of config.AUTOMATED_PREFIXES) {
      if (local === p || local.startsWith(p + '.') || local.startsWith(p + '-')) return false;
    }
    if (email.length < 5 || email.length > 100) return false;
    if (email.includes('..') || email.startsWith('.') || email.endsWith('.')) return false;
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(email)) return false;
    return true;
  });
}

function extractOwnerName(html, $) {
  const text = $ ? $.text() : html.replace(/<[^>]+>/g, ' ');
  const falsePositives = new Set(['Read More', 'Learn More', 'Click Here', 'Find Out', 'Contact Us', 'About Us', 'Our Team', 'Get Quote', 'Free Quote']);

  for (const keyword of config.OWNER_KEYWORDS) {
    const idx = text.toLowerCase().indexOf(keyword);
    if (idx === -1) continue;
    const surrounding = text.substring(idx, idx + 150);
    const nameMatches = surrounding.match(NAME_REGEX);
    if (nameMatches) {
      const name = nameMatches[0];
      if (!falsePositives.has(name)) return name;
    }
  }

  if ($) {
    const author = $('meta[name="author"]').attr('content');
    if (author && /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/.test(author)) return author.trim();

    let jsonLdName = '';
    $('script[type="application/ld+json"]').each((_, el) => {
      if (jsonLdName) return false;
      try {
        const data = JSON.parse($(el).html());
        if (data['@type'] === 'Person' && data.name) jsonLdName = data.name;
        else if (data.founder?.name) jsonLdName = data.founder.name;
      } catch {}
    });
    if (jsonLdName) return jsonLdName;
  }

  return '';
}

function extractCompanyName($, url) {
  if (!$) return '';
  const ogName = $('meta[property="og:site_name"]').attr('content');
  if (ogName) return ogName.trim();
  const title = $('title').text();
  if (title) return title.split(/\s*[|\-–—]\s*/)[0].trim();
  const h1 = $('h1').first().text();
  if (h1) return h1.trim();
  return '';
}

function extractPhone(html) {
  const matches = html.match(PHONE_REGEX) || [];
  const phones = [...new Set(
    matches
      .map(p => p.replace(/[^\d+]/g, ''))
      .filter(p => p.length >= 8 && p.length <= 16)
  )];
  return phones[0] || '';
}

function extractInstagramHandle(html) {
  // Try from instagram.com/ links first
  let m;
  const urlRe = new RegExp(IG_URL_REGEX.source, 'g');
  while ((m = urlRe.exec(html)) !== null) {
    const handle = m[1];
    if (handle && !IG_SKIP.has(handle)) return '@' + handle;
  }
  // Try @handle pattern in text
  const textRe = new RegExp(IG_HANDLE_REGEX.source, 'gm');
  const plain = html.replace(/<[^>]+>/g, ' ');
  while ((m = textRe.exec(plain)) !== null) {
    const handle = m[1];
    if (handle && !IG_SKIP.has(handle) && handle.length >= 2) return '@' + handle;
  }
  return '';
}

async function scrapeSite(company, verbose = false, collectOptions = ['email']) {
  const { website, companyName: dirCompanyName, industry, location, source, instagramHandle: dirHandle } = company;

  if (!website) return null;

  let baseUrl = website;
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
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

  // Skip most subpages if homepage already yielded emails (faster)
  const subpages = allEmails.length > 0 ? config.CONTACT_SUBPAGES_QUICK : config.CONTACT_SUBPAGES;

  const limit = pLimit(3);
  const subpagePromises = subpages.map(subpage =>
    limit(async () => {
      try {
        const html = await fetchWithRetry(baseUrl + subpage, {
          delayMin: config.SITE_DELAY_MIN,
          delayMax: config.SITE_DELAY_MAX,
          maxRetries: 0
        });
        if (html && typeof html === 'string') {
          allHtml += html;
          allEmails.push(...extractEmails(html));
          if (!ownerName) ownerName = extractOwnerName(html, cheerio.load(html));
        }
      } catch {}
    })
  );

  await Promise.all(subpagePromises);

  const filteredEmails = filterEmails([...new Set(allEmails)]);

  if (filteredEmails.length === 0) return null;

  // Prefer personal emails
  let bestEmail = filteredEmails[0];
  let bestType  = classifyEmail(bestEmail);
  for (const email of filteredEmails) {
    const t = classifyEmail(email);
    if (t === 'personal' && bestType !== 'personal') { bestEmail = email; bestType = t; break; }
  }

  // Optional data collection
  const phone = collectOptions.includes('phone') ? extractPhone(allHtml) : '';
  const instagramHandle = collectOptions.includes('instagram')
    ? (extractInstagramHandle(allHtml) || dirHandle || '')
    : (dirHandle || '');

  const emailType    = classifyEmail(bestEmail);
  const isICPSignal  = detectICPSignal(allHtml);
  const isAntiICP    = detectAntiICP(allHtml);
  const hasBuyerTitle = detectBuyerTitle(allHtml);

  const lead = {
    email: bestEmail,
    ownerName:       ownerName || '',
    companyName:     siteName  || '',
    website:         baseUrl,
    industry:        industry  || '',
    location:        location  || '',
    phone,
    instagramHandle,
    emailType,
    isICPSignal,
    isAntiICP,
    hasBuyerTitle,
    source:          source    || '',
    qualityScore:    0
  };

  lead.qualityScore = scoreLead(lead);
  return lead;
}

module.exports = { scrapeSite, extractEmails, filterEmails };
