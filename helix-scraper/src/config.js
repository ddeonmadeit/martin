require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

module.exports = {
  // ── Speed settings ─────────────────────────────────────────────
  // Site scraping: near-zero delay — each domain is different, minimal rate-limit risk
  SITE_DELAY_MIN: 0,
  SITE_DELAY_MAX: 150,
  SITE_CONCURRENCY: parseInt(process.env.SITE_CONCURRENCY, 10) || 25,

  // Search engines: reduced from 5-12s to 1-2.5s — still safe against blocks
  SEARCH_DELAY_MIN: 1000,
  SEARCH_DELAY_MAX: 2500,
  SEARCH_CONCURRENCY: 1,
  // How many segment×location combos to search in parallel (DDG+Bing run inside each)
  SEARCH_PARALLEL: parseInt(process.env.SEARCH_PARALLEL, 10) || 4,

  // Network: tighter timeouts = faster failure recovery
  REQUEST_TIMEOUT: 7000,
  MAX_RETRIES: 1,
  RETRY_BACKOFF_BASE: 1500,

  // ── Target ─────────────────────────────────────────────────────
  TARGET_LEADS: parseInt(process.env.TARGET_LEADS, 10) || 2000,

  // ── Paths ──────────────────────────────────────────────────────
  // Set OUTPUT_DIR env var in Railway and mount a volume there for persistence
  // Example: OUTPUT_DIR=/data  (then mount Railway volume at /data)
  OUTPUT_DIR: process.env.OUTPUT_DIR || require('path').join(__dirname, '..', 'output'),
  DATA_DIR: require('path').join(__dirname, '..', 'data'),

  // ── Email filtering ────────────────────────────────────────────
  FREE_EMAIL_DOMAINS: [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'icloud.com', 'live.com', 'yahoo.com.au', 'hotmail.com.au',
    'live.com.au', 'outlook.com.au', 'mail.com', 'aol.com',
    'protonmail.com', 'zoho.com'
  ],

  AUTOMATED_PREFIXES: [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
    'postmaster', 'bounce', 'auto', 'daemon'
  ],

  GENERIC_PREFIXES: [
    'info', 'admin', 'sales', 'hello', 'enquiries', 'enquiry',
    'office', 'reception', 'contact', 'accounts', 'support',
    'general', 'mail', 'team', 'help'
  ],

  JUNK_DOMAINS: [
    'facebook.com', 'instagram.com', 'youtube.com', 'linkedin.com',
    'twitter.com', 'x.com', 'pinterest.com', 'tiktok.com',
    'yelp.com', 'tripadvisor.com', 'wikipedia.org', 'reddit.com',
    'amazon.com', 'ebay.com', 'etsy.com', 'shopify.com',
    'crunchbase.com', 'clutch.co', 'g2.com', 'trustpilot.com',
    'glassdoor.com', 'indeed.com', 'seek.com.au', 'seek.co.nz',
    'gumtree.com.au', 'yellowpages.com.au', 'truelocal.com.au',
    'upwork.com', 'fiverr.com', 'bark.com', 'angel.co',
    'producthunt.com', 'techcrunch.com', 'forbes.com', 'inc.com',
    'medium.com', 'substack.com'
  ],

  // ── ICP scoring ────────────────────────────────────────────────
  ICP_SIGNAL_KEYWORDS: [
    'ugc', 'ugc ads', 'ugc agency', 'ugc studio',
    'performance creative', 'creative testing', 'ad creative',
    'dtc', 'direct-to-consumer', 'direct to consumer',
    'meta ads', 'facebook ads', 'tiktok ads',
    'paid social', 'paid media',
    'creative strategist', 'creative strategy',
    'ad creative at scale', 'scaling creative',
    '100+ ads', 'volume creative', 'creative production',
    'growth marketing', 'performance marketing',
    'direct response', 'scroll-stopping'
  ],

  ANTI_ICP_KEYWORDS: [
    'b2b saas', 'enterprise marketing', 'pr agency', 'public relations',
    'web3', 'crypto', 'nft', 'influencer marketing', 'brand awareness',
    'corporate video', 'event management', 'traditional media'
  ],

  OWNER_KEYWORDS: [
    'founder', 'co-founder', 'owner', 'director', 'managing director',
    'ceo', 'chief executive', 'head of production', 'head of creative',
    'head of paid social', 'creative director', 'creative strategist',
    'performance creative lead', 'head of growth', 'vp growth',
    'director of performance marketing', 'growth lead'
  ],

  BUYER_TITLES_TIER1: [
    'founder', 'head of production', 'creative director',
    'head of creative', 'creative strategist', 'performance creative lead',
    'head of paid social', 'director of performance marketing', 'vp growth'
  ],

  // ── Subpages to check (ordered by email-find likelihood) ──────
  CONTACT_SUBPAGES: [
    '/contact', '/contact-us', '/contact.html',
    '/about', '/about-us', '/about.html',
    '/team', '/our-team', '/meet-the-team',
    '/work-with-us', '/hire-us', '/services'
  ],

  // Quick subpages — used when homepage already has emails
  CONTACT_SUBPAGES_QUICK: [
    '/contact', '/contact-us'
  ],

  // ── Block handling ─────────────────────────────────────────────
  BLOCK_PAUSE_MS: 20000,
  BLOCK_LONG_PAUSE_MS: 120000,
  MAX_CONSECUTIVE_BLOCKS: 3,

  VERBOSE: process.env.VERBOSE === 'true'
};
