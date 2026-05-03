class Deduplicator {
  constructor() {
    this.seenEmails = new Set();
    this.seenDomains = new Set();
  }

  hasEmail(email) {
    return this.seenEmails.has(email.toLowerCase());
  }

  hasDomain(domain) {
    return this.seenDomains.has(domain.toLowerCase());
  }

  addEmail(email) {
    this.seenEmails.add(email.toLowerCase());
  }

  addDomain(domain) {
    this.seenDomains.add(domain.toLowerCase());
  }

  extractDomain(url) {
    try {
      const hostname = new URL(url.startsWith('http') ? url : `http://${url}`).hostname;
      return hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  isDomainNew(url) {
    const domain = this.extractDomain(url);
    if (!domain) return false;
    return !this.hasDomain(domain);
  }

  registerDomain(url) {
    const domain = this.extractDomain(url);
    if (domain) {
      this.addDomain(domain);
    }
    return domain;
  }

  get emailCount() {
    return this.seenEmails.size;
  }

  get domainCount() {
    return this.seenDomains.size;
  }
}

module.exports = Deduplicator;
