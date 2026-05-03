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
const db = require('./database');

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

function ts() {
  return new Date().toLocaleTimeString('en-AU', { hour12: false });
}

function stars(score) {
  const n = Math.max(0, Math.min(5, Math.round(score)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function rpad(str, len) {
  return String(str || '').padEnd(len).slice(0, len);
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
    console.log(`[${ts()}]  ABORT   Stop requested — finishing active tasks…`);
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
            console.log(`[${ts()}]  RESUME  ${existing} existing leads loaded`);
          }
        } catch (err) {
          this.emit('log', { type: 'warn', message: `Could not load existing CSV: ${err.message}` });
        }
      }

      csvWriter.init(this.resume);
      this.leadCount = csvWriter.leadCount;

      const targetSegments = this.getSegments();
      const targetLocations = this.getLocations();
      const totalCombos = targetSegments.length * targetLocations.length;

      console.log(`\n${'━'.repeat(72)}`);
      console.log(`  PREEMO LEADS  target=${this.target}  segments=${targetSegments.length}  locations=${targetLocations.length}  combos=${totalCombos}`);
      console.log(`${'━'.repeat(72)}\n`);

      const self = this;

      // Shared site-scraping pool — active throughout entire run
      const siteLimit = pLimit(config.SITE_CONCURRENCY);
      const allSiteTasks = [];

      function queueSite(company) {
        const task = siteLimit(async () => {
          if (self.leadCount >= self.target || self.aborted) return;
          try {
            await randomDelay(config.SITE_DELAY_MIN, config.SITE_DELAY_MAX);
            const lead = await scrapeSite(company, self.verbose);
            tryAddLead(lead);
          } catch (err) {
            logError(`Site ${company.website}: ${err.message}`);
          } finally {
            self.domainsScraped++;
          }
        });
        allSiteTasks.push(task);
      }

      function tryAddLead(lead) {
        if (self.leadCount >= self.target) return false;
        if (self.aborted) return false;
        if (!lead || !lead.email) return false;
        if (dedup.hasEmail(lead.email)) return false;

        dedup.addEmail(lead.email);
        csvWriter.writeLead(lead);
        try { db.upsertLead(lead); } catch (_) {}
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

        const num = String(self.leadCount).padStart(4, '0');
        console.log(
          `[${ts()}]  #${num}  ${rpad(lead.email, 38)}  ${rpad(lead.companyName || '—', 24)}  ${rpad(lead.emailType || 'generic', 9)}  ${stars(lead.qualityScore || 0)}`
        );

        return true;
      }

      // Print progress summary every 30 s
      let lastProgressPrint = Date.now();
      function maybePrintProgress() {
        if (Date.now() - lastProgressPrint < 30000) return;
        lastProgressPrint = Date.now();
        const elapsed = Math.round((Date.now() - self.startTime) / 1000);
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');
        console.log(`\n[${ts()}]  ── ${self.leadCount} leads │ ${self.domainsScraped} domains scraped │ ${mm}:${ss} elapsed ──\n`);
      }

      // ═══════════ SEARCH + SCRAPE (interleaved) ═══════════
      this.phase = 'searching';
      this.emit('log', { type: 'phase', message: 'Searching and extracting emails simultaneously' });
      this.emit('progress', this.getStatus());

      // Shuffle combos so coverage is spread across segments/locations
      const allCombos = [];
      for (const seg of targetSegments) {
        for (const loc of targetLocations) {
          allCombos.push({ seg, loc });
        }
      }
      for (let i = allCombos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allCombos[i], allCombos[j]] = [allCombos[j], allCombos[i]];
      }

      const searchLimit = pLimit(config.SEARCH_PARALLEL);

      const searchTasks = allCombos.map(({ seg, loc }) =>
        searchLimit(async () => {
          if (self.leadCount >= self.target || self.aborted) return;
          maybePrintProgress();

          const engines = [];

          if (self.enabledSources.includes('duckduckgo')) {
            engines.push(
              searchDuckDuckGo(seg, loc, self.verbose)
                .then(r => r.map(x => ({ ...x, source: 'duckduckgo' })))
                .catch(err => {
                  logError(`DDG ${seg.slug}/${loc.slug}: ${err.message}`);
                  return [];
                })
            );
          }

          if (self.enabledSources.includes('bing')) {
            engines.push(
              searchBing(seg, loc, self.verbose)
                .then(r => r.map(x => ({ ...x, source: 'bing' })))
                .catch(err => {
                  logError(`Bing ${seg.slug}/${loc.slug}: ${err.message}`);
                  return [];
                })
            );
          }

          const allResults = (await Promise.all(engines)).flat();

          let newCount = 0;
          for (const r of allResults) {
            if (dedup.isDomainNew(r.website)) {
              dedup.registerDomain(r.website);
              queueSite({ website: r.website, companyName: '', industry: seg.label, location: loc.label, source: r.source });
              newCount++;
            }
          }

          if (newCount > 0) {
            const msg = `${seg.slug}/${loc.slug} → ${newCount} new domains`;
            self.emit('log', { type: 'success', message: msg });
            console.log(`[${ts()}]  SEARCH  ${msg}`);
          }
        })
      );

      await Promise.all(searchTasks);

      console.log(`\n[${ts()}]  SEARCH DONE  all combos complete — waiting for scrapers to finish…\n`);
      this.emit('log', { type: 'info', message: `Search complete — waiting for scrapers to finish…` });

      await Promise.all(allSiteTasks);
      this.domainsScraped = dedup.domainCount;

      // ═══════════ FALLBACK QUERIES ═══════════
      if (this.leadCount < this.target && !this.aborted) {
        this.phase = 'phase3';
        const need = this.target - this.leadCount;
        console.log(`\n[${ts()}]  FALLBACK  need ${need} more leads — running fallback queries\n`);
        this.emit('log', { type: 'phase', message: `Fallback queries — need ${need} more leads` });
        this.emit('progress', this.getStatus());

        const fbSegments = targetSegments.slice(0, 8);
        const fbLocations = targetLocations.slice(0, 6);

        const fbCombos = [];
        for (const seg of fbSegments) {
          for (const loc of fbLocations) {
            fbCombos.push({ seg, loc });
          }
        }

        const fbSiteTasks = [];
        const fbSearchLimit = pLimit(config.SEARCH_PARALLEL);

        const fbSearchTasks = fbCombos.map(({ seg, loc }) =>
          fbSearchLimit(async () => {
            if (self.leadCount >= self.target || self.aborted) return;

            const fbEngines = [];

            if (self.enabledSources.includes('duckduckgo')) {
              fbEngines.push((async () => {
                const results = [];
                for (const q of ddgFallback(seg, loc)) {
                  try {
                    const stub = { label: q, searchKeywords: [q] };
                    const r = await searchDuckDuckGo(stub, loc, self.verbose);
                    results.push(...r.map(x => ({ ...x, source: 'duckduckgo' })));
                  } catch (err) {
                    logError(`DDG fallback ${seg.slug}/${loc.slug}: ${err.message}`);
                  }
                }
                return results;
              })());
            }

            if (self.enabledSources.includes('bing')) {
              fbEngines.push((async () => {
                const results = [];
                for (const q of bingFallback(seg, loc)) {
                  try {
                    const stub = { label: q, searchKeywords: [q] };
                    const r = await searchBing(stub, loc, self.verbose);
                    results.push(...r.map(x => ({ ...x, source: 'bing' })));
                  } catch (err) {
                    logError(`Bing fallback ${seg.slug}/${loc.slug}: ${err.message}`);
                  }
                }
                return results;
              })());
            }

            const allResults = (await Promise.all(fbEngines)).flat();
            let added = 0;

            for (const r of allResults) {
              if (dedup.isDomainNew(r.website)) {
                dedup.registerDomain(r.website);
                const company = { website: r.website, companyName: '', industry: seg.label, location: loc.label, source: r.source };
                const task = siteLimit(async () => {
                  if (self.leadCount >= self.target || self.aborted) return;
                  try {
                    await randomDelay(config.SITE_DELAY_MIN, config.SITE_DELAY_MAX);
                    const lead = await scrapeSite(company, self.verbose);
                    tryAddLead(lead);
                  } catch (err) {
                    logError(`Site ${company.website}: ${err.message}`);
                  } finally {
                    self.domainsScraped++;
                  }
                });
                fbSiteTasks.push(task);
                added++;
              }
            }

            if (added > 0) {
              console.log(`[${ts()}]  FALLBACK  ${seg.slug}/${loc.slug} → ${added} new domains`);
            }
          })
        );

        await Promise.all(fbSearchTasks);
        await Promise.all(fbSiteTasks);
        this.domainsScraped = dedup.domainCount;
        this.emit('progress', this.getStatus());
      }

      csvWriter.close();
      this.phase = 'done';
      this.running = false;

      const elapsed = Math.round((Date.now() - this.startTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      console.log(`\n${'━'.repeat(72)}`);
      console.log(`  DONE  ${this.leadCount}/${this.target} leads  │  ${this.domainsScraped} domains  │  ${mm}:${ss} elapsed`);
      console.log(`${'━'.repeat(72)}\n`);

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
