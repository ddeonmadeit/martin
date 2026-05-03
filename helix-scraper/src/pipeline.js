const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');
const EventEmitter = require('events');

const config = require('./config');
const { searchDuckDuckGo, buildFallbackQueries: ddgFallback } = require('./scrapers/duckSearch');
const { searchBing, buildFallbackQueries: bingFallback } = require('./scrapers/bingSearch');
const { scrapeSite } = require('./siteScraper');
const Deduplicator = require('./deduplicator');
const CsvWriter = require('./csvWriter');
const { randomDelay } = require('./proxyRotator');

const segments = require(path.join(config.DATA_DIR, 'industries.json'));
const locations = require(path.join(config.DATA_DIR, 'locations.json'));

const ERROR_LOG = path.join(config.OUTPUT_DIR, 'errors.log');

function logError(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (!fs.existsSync(config.OUTPUT_DIR)) {
      fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
    }
    fs.appendFileSync(ERROR_LOG, line);
  } catch {}
}

class ScraperPipeline extends EventEmitter {
  constructor(options = {}) {
    super();
    this.target = options.target || config.TARGET_LEADS;
    this.resume = options.resume || false;
    this.enabledSources = options.sources || ['duckduckgo', 'bing'];
    this.segmentFilter = options.industry || null;
    this.locationFilter = options.location || null;
    this.verbose = options.verbose || false;

    this.leadCount = 0;
    this.domainsScraped = 0;
    this.personalCount = 0;
    this.genericCount = 0;
    this.phase = 'idle';
    this.running = false;
    this.aborted = false;
    this.startTime = null;
    this.recentLeads = [];
  }

  getSegments() {
    if (!this.segmentFilter) return segments.categories;
    const q = this.segmentFilter.toLowerCase();
    return segments.categories.filter(c =>
      c.slug.includes(q) || c.label.toLowerCase().includes(q)
    );
  }

  getLocations() {
    if (!this.locationFilter) return locations.locations;
    const q = this.locationFilter.toLowerCase();
    return locations.locations.filter(l =>
      l.slug.includes(q) || l.label.toLowerCase().includes(q) ||
      (l.country && l.country.toLowerCase() === q)
    );
  }

  getStatus() {
    const elapsed = this.startTime ? Date.now() - this.startTime : 0;
    return {
      running: this.running,
      phase: this.phase,
      leadCount: this.leadCount,
      target: this.target,
      domainsScraped: this.domainsScraped,
      personalCount: this.personalCount,
      genericCount: this.genericCount,
      elapsed,
      recentLeads: this.recentLeads.slice(-20)
    };
  }

  abort() {
    this.aborted = true;
    this.emit('log', { type: 'warn', message: 'Abort requested — finishing current tasks...' });
  }

  async run() {
    if (this.running) throw new Error('Pipeline is already running');
    this.running = true;
    this.aborted = false;
    this.startTime = Date.now();
    this.phase = 'init';

    const dedup = new Deduplicator();
    const csvWriter = new CsvWriter();

    try {
      if (this.resume) {
        try {
          const existing = await csvWriter.loadExisting(dedup);
          if (existing > 0) {
            this.leadCount = existing;
            this.emit('log', { type: 'info', message: `Resumed — ${existing} existing leads loaded` });
          }
        } catch (err) {
          this.emit('log', { type: 'warn', message: `Could not load existing CSV: ${err.message}` });
        }
      }

      csvWriter.init(this.resume);
      this.leadCount = csvWriter.leadCount;

      const companyQueue = [];
      const targetSegments = this.getSegments();
      const targetLocations = this.getLocations();

      const self = this;

      function tryAddLead(lead) {
        if (self.leadCount >= self.target) return false;
        if (self.aborted) return false;
        if (!lead || !lead.email) return false;
        if (dedup.hasEmail(lead.email)) return false;

        dedup.addEmail(lead.email);
        csvWriter.writeLead(lead);
        self.leadCount++;

        if (lead.emailType === 'personal') self.personalCount++;
        else self.genericCount++;

        const entry = {
          email: lead.email,
          ownerName: lead.ownerName || '',
          companyName: lead.companyName || '',
          website: lead.website || '',
          industry: lead.industry || '',
          location: lead.location || '',
          emailType: lead.emailType,
          qualityScore: lead.qualityScore,
          source: lead.source
        };
        self.recentLeads.push(entry);
        if (self.recentLeads.length > 50) self.recentLeads.shift();

        self.emit('lead', entry);
        self.emit('progress', self.getStatus());
        return true;
      }

      // ═══════════ PHASE 1 — ICP Keyword Search ═══════════
      this.phase = 'phase1';
      this.emit('log', { type: 'phase', message: 'Phase 1 — ICP keyword search (DDG + Bing)' });
      this.emit('progress', this.getStatus());

      for (const seg of targetSegments) {
        for (const loc of targetLocations) {
          if (this.leadCount >= this.target || this.aborted) break;

          if (this.enabledSources.includes('duckduckgo')) {
            try {
              const results = await searchDuckDuckGo(seg, loc, this.verbose);
              for (const r of results) {
                if (dedup.isDomainNew(r.website)) {
                  dedup.registerDomain(r.website);
                  companyQueue.push({ website: r.website, companyName: '', industry: seg.label, location: loc.label, source: 'duckduckgo' });
                }
              }
              if (results.length > 0) {
                this.emit('log', { type: 'success', message: `DDG: ${seg.slug}/${loc.slug} — ${results.length} domains` });
              }
            } catch (err) {
              logError(`DDG ${seg.slug}/${loc.slug}: ${err.message}`);
            }
          }

          if (this.enabledSources.includes('bing')) {
            try {
              const results = await searchBing(seg, loc, this.verbose);
              for (const r of results) {
                if (dedup.isDomainNew(r.website)) {
                  dedup.registerDomain(r.website);
                  companyQueue.push({ website: r.website, companyName: '', industry: seg.label, location: loc.label, source: 'bing' });
                }
              }
              if (results.length > 0) {
                this.emit('log', { type: 'success', message: `Bing: ${seg.slug}/${loc.slug} — ${results.length} domains` });
              }
            } catch (err) {
              logError(`Bing ${seg.slug}/${loc.slug}: ${err.message}`);
            }
          }
        }
        if (this.leadCount >= this.target || this.aborted) break;
      }

      this.domainsScraped = dedup.domainCount;
      this.emit('log', { type: 'info', message: `Phase 1 complete — ${companyQueue.length} domains queued` });
      this.emit('progress', this.getStatus());

      // ═══════════ PHASE 2 — Email Extraction ═══════════
      if (companyQueue.length > 0 && this.leadCount < this.target && !this.aborted) {
        this.phase = 'phase2';
        this.emit('log', { type: 'phase', message: `Phase 2 — Extracting emails from ${companyQueue.length} websites` });
        this.emit('progress', this.getStatus());

        const siteLimit = pLimit(config.SITE_CONCURRENCY);
        const siteTasks = companyQueue.map(company =>
          siteLimit(async () => {
            if (this.leadCount >= this.target || this.aborted) return;
            try {
              await randomDelay(config.SITE_DELAY_MIN, config.SITE_DELAY_MAX);
              const lead = await scrapeSite(company, this.verbose);
              tryAddLead(lead);
            } catch (err) {
              logError(`Site ${company.website}: ${err.message}`);
            }
          })
        );

        await Promise.all(siteTasks);
        this.domainsScraped = dedup.domainCount;
        this.emit('log', { type: 'info', message: `Phase 2 complete — ${this.leadCount} leads` });
        this.emit('progress', this.getStatus());
      }

      // ═══════════ PHASE 3 — Fallback Queries ═══════════
      if (this.leadCount < this.target && !this.aborted) {
        this.phase = 'phase3';
        this.emit('log', { type: 'phase', message: `Phase 3 — Fallback queries (need ${this.target - this.leadCount} more)` });
        this.emit('progress', this.getStatus());

        const fallbackSegments = targetSegments.slice(0, 8);
        const fallbackLocations = targetLocations.slice(0, 6);

        for (const seg of fallbackSegments) {
          for (const loc of fallbackLocations) {
            if (this.leadCount >= this.target || this.aborted) break;

            const newDomains = [];
            const fbQ = ddgFallback(seg, loc);

            if (this.enabledSources.includes('duckduckgo')) {
              try {
                for (const query of fbQ) {
                  const stub = { label: query, searchKeywords: [query] };
                  const results = await searchDuckDuckGo(stub, loc, this.verbose);
                  for (const r of results) {
                    if (dedup.isDomainNew(r.website)) {
                      dedup.registerDomain(r.website);
                      newDomains.push({ website: r.website, companyName: '', industry: seg.label, location: loc.label, source: 'duckduckgo' });
                    }
                  }
                }
              } catch (err) {
                logError(`DDG fallback ${seg.slug}/${loc.slug}: ${err.message}`);
              }
            }

            if (this.enabledSources.includes('bing')) {
              try {
                for (const query of bingFallback(seg, loc)) {
                  const stub = { label: query, searchKeywords: [query] };
                  const results = await searchBing(stub, loc, this.verbose);
                  for (const r of results) {
                    if (dedup.isDomainNew(r.website)) {
                      dedup.registerDomain(r.website);
                      newDomains.push({ website: r.website, companyName: '', industry: seg.label, location: loc.label, source: 'bing' });
                    }
                  }
                }
              } catch (err) {
                logError(`Bing fallback ${seg.slug}/${loc.slug}: ${err.message}`);
              }
            }

            if (newDomains.length > 0) {
              this.emit('log', { type: 'info', message: `Fallback: ${seg.slug}/${loc.slug} — ${newDomains.length} new domains` });
              const siteLimit = pLimit(config.SITE_CONCURRENCY);
              const siteTasks = newDomains.map(company =>
                siteLimit(async () => {
                  if (this.leadCount >= this.target || this.aborted) return;
                  try {
                    await randomDelay(config.SITE_DELAY_MIN, config.SITE_DELAY_MAX);
                    const lead = await scrapeSite(company, this.verbose);
                    tryAddLead(lead);
                  } catch (err) {
                    logError(`Site ${company.website}: ${err.message}`);
                  }
                })
              );
              await Promise.all(siteTasks);
            }
          }
          if (this.leadCount >= this.target || this.aborted) break;
        }

        this.domainsScraped = dedup.domainCount;
        this.emit('progress', this.getStatus());
      }

      csvWriter.close();
      this.phase = 'done';
      this.running = false;

      const finalStatus = this.getStatus();
      this.emit('log', { type: 'phase', message: `Complete — ${this.leadCount}/${this.target} leads collected` });
      this.emit('done', finalStatus);
      return finalStatus;

    } catch (err) {
      csvWriter.close();
      this.phase = 'error';
      this.running = false;
      logError(`FATAL: ${err.stack}`);
      this.emit('error', err.message);
      throw err;
    }
  }
}

module.exports = {
  ScraperPipeline,
  industries: segments.categories,
  locations: locations.locations
};
