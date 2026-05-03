const config = require('./config');

function classifyEmail(email) {
  if (!email) return null;
  const local = email.split('@')[0].toLowerCase();

  for (const prefix of config.AUTOMATED_PREFIXES) {
    if (local === prefix || local.startsWith(prefix + '.') || local.startsWith(prefix + '-')) {
      return 'automated';
    }
  }

  for (const prefix of config.GENERIC_PREFIXES) {
    if (local === prefix || local.startsWith(prefix + '.') || local.startsWith(prefix + '-')) {
      return 'generic';
    }
  }

  return 'personal';
}

function isFreeDomain(email) {
  if (!email) return true;
  const domain = email.split('@')[1].toLowerCase();
  return config.FREE_EMAIL_DOMAINS.includes(domain);
}

function detectICPSignal(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const keyword of config.ICP_SIGNAL_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

function detectAntiICP(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const keyword of config.ANTI_ICP_KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

function detectBuyerTitle(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const title of config.BUYER_TITLES_TIER1) {
    if (lower.includes(title)) return true;
  }
  return false;
}

function scoreLead(lead) {
  let score = 0;

  // +1 personal email
  if (lead.emailType === 'personal') score++;

  // +1 owner/buyer name found
  if (lead.ownerName && lead.ownerName.trim()) score++;

  // +1 ICP signal detected on the site
  if (lead.isICPSignal) score++;

  // +1 buyer title detected
  if (lead.hasBuyerTitle) score++;

  // +1 segment/industry identified
  if (lead.industry && lead.industry.trim()) score++;

  // -1 anti-ICP signal detected
  if (lead.isAntiICP) score = Math.max(0, score - 1);

  return Math.max(1, Math.min(5, score));
}

module.exports = {
  classifyEmail,
  isFreeDomain,
  scoreLead,
  detectICPSignal,
  detectAntiICP,
  detectBuyerTitle
};
