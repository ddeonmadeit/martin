require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

module.exports = {
  // Website scraping
  SITE_DELAY_MIN: 800,
  SITE_DELAY_MAX: 2500,
  SITE_CONCURRENCY: parseInt(process.env.SITE_CONCURRENCY, 10) || 10,

  // Search engine scraping
  SEARCH_DELAY_MIN: 5000,
  SEARCH_DELAY_MAX: 12000,
  SEARCH_CONCURRENCY: 1,

  // General
  REQUEST_TIMEOUT: 10000,
  MAX_RETRIES: 2,
  RETRY_BACKOFF_BASE: 5000,

  // Target
  TARGET_LEADS: parseInt(process.env.TARGET_LEADS, 10) || 2000,

  // Paths
  OUTPUT_DIR: require('path').join(__dirname, '..', 'output'),
  DATA_DIR: require('path').join(__dirname, '..', 'data'),

  // Free email domains to discard
  FREE_EMAIL_DOMAINS: [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'icloud.com', 'live.com', 'yahoo.com.au', 'hotmail.com.au',
    'live.com.au', 'outlook.com.au', 'mail.com', 'aol.com',
    'protonmail.com', 'zoho.com'
  ],

  // Automated email prefixes to discard
  AUTOMATED_PREFIXES: [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
    'postmaster', 'bounce', 'auto', 'daemon'
  ],

  // Generic email prefixes
  GENERIC_PREFIXES: [
    'info', 'admin', 'sales', 'hello', 'enquiries', 'enquiry',
    'office', 'reception', 'contact', 'accounts', 'support',
    'general', 'mail', 'team', 'help'
  ],

  // Junk domains to skip from search results
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

  // ICP signal keywords — presence on a site increases lead quality score
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

  // Anti-ICP signals — presence downgrades quality score
  ANTI_ICP_KEYWORDS: [
    'b2b saas', 'enterprise marketing', 'pr agency', 'public relations',
    'web3', 'crypto', 'nft', 'influencer marketing', 'brand awareness',
    'corporate video', 'event management', 'traditional media'
  ],

  // Buyer/decision-maker title keywords for owner detection
  OWNER_KEYWORDS: [
    'founder', 'co-founder', 'owner', 'director', 'managing director',
    'ceo', 'chief executive', 'head of production', 'head of creative',
    'head of paid social', 'creative director', 'creative strategist',
    'performance creative lead', 'head of growth', 'vp growth',
    'director of performance marketing', 'growth lead'
  ],

  // Tier 1 buyer titles for bonus scoring
  BUYER_TITLES_TIER1: [
    'founder', 'head of production', 'creative director',
    'head of creative', 'creative strategist', 'performance creative lead',
    'head of paid social', 'director of performance marketing', 'vp growth'
  ],

  // Subpages to check for emails
  CONTACT_SUBPAGES: [
    '/contact', '/contact-us', '/contact.html',
    '/about', '/about-us', '/about.html',
    '/team', '/our-team', '/meet-the-team',
    '/work-with-us', '/hire-us', '/services'
  ],

  // Block tracking per source
  BLOCK_PAUSE_MS: 30000,
  BLOCK_LONG_PAUSE_MS: 300000,
  MAX_CONSECUTIVE_BLOCKS: 3,

  VERBOSE: process.env.VERBOSE === 'true'
};
