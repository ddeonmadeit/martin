#!/usr/bin/env node

const { program } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const pLimit = require('p-limit');

const config = require('./src/config');
const { searchDuckDuckGo, buildFallbackQueries: ddgFallback } = require('./src/scrapers/duckSearch');
const { searchBing, buildFallbackQueries: bingFallback } = require('./src/scrapers/bingSearch');
const { scrapeSite } = require('./src/siteScraper');
const Deduplicator = require('./src/deduplicator');
const CsvWriter = require('./src/csvWriter');
const { randomDelay } = require('./src/proxyRotator');

const segments = require('./data/industries.json');
const locations = require('./data/locations.json');

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

program
  .option('--target <number>', 'Target number of leads', parseInt)
  .option('--resume', 'Resume from existing CSV')
  .option('--sources <list>', 'Comma-separated sources: duckduckgo,bing')
  .option('--segment <name>', 'Target specific ICP segment slug or label (e.g. ugc-agency)')
  .option('--location <name>', 'Target specific location slug, label, or country code (e.g. AU)')
  .option('--verbose', 'Verbose logging')
  .parse(process.argv);

const opts = program.opts();
const TARGET = opts.target || config.TARGET_LEADS;
const VERBOSE = opts.verbose || config.VERBOSE;
const RESUME = opts.resume || false;

const enabledSources = opts.sources
  ? opts.sources.split(',').map(s => s.trim().toLowerCase())
  : ['duckduckgo', 'bing'];

function filterSegments() {
  if (!opts.segment) return segments.categories;
  const q = opts.segment.toLowerCase();
  return segments.categories.filter(c =>
    c.slug.includes(q) || c.label.toLowerCase().includes(q)
  );
}

function filterLocations() {
  if (!opts.location) return locations.locations;
  const q = opts.location.toLowerCase();
  return locations.locations.filter(l =>
    l.slug.includes(q) || l.label.toLowerCase().includes(q) ||
    (l.country && l.country.toLowerCase() === q)
  );
}

async function main() {
  const startTime = Date.now();

  console.log(chalk.bold.cyan('\n  Helix ICP Scraper — Performance Creative & UGC'));
  console.log(chalk.gray(`  Target: ${TARGET} leads\n`));

  const dedup = new Deduplicator();
  const csvWriter = new CsvWriter();

  if (RESUME) {
    try {
      const existing = await csvWriter.loadExisting(dedup);
      if (existing > 0) {
        console.log(chalk.yellow(`  Resuming — ${existing} existing leads loaded\n`));
      }
    } catch (err) {
      console.log(chalk.yellow(`  Could not load existing CSV: ${err.message}\n`));
    }
  }

  csvWriter.init(RESUME);

  let leadCount = csvWriter.leadCount;
  const companyQueue = [];

  const targetSegments = filterSegments();
  const targetLocations = filterLocations();

  function tryAddLead(lead) {
    if (leadCount >= TARGET) return false;
    if (!lead || !lead.email) return false;
    if (dedup.hasEmail(lead.email)) return false;

    dedup.addEmail(lead.email);
    csvWriter.writeLead(lead);
    leadCount++;
    return true;
  }

  // ═══════════════════════════════════
  // PHASE 1 — ICP Keyword Search
  // ═══════════════════════════════════
  console.log(chalk.bold.white('[Phase 1] ICP keyword search (DDG + Bing)...\n'));

  for (const seg of targetSegments) {
    if (leadCount >= TARGET) break;
    console.log(chalk.yellow(`  → ${seg.label} (Tier ${seg.tier})`));

    for (const loc of targetLocations) {
      if (leadCount >= TARGET) break;

      if (enabledSources.includes('duckduckgo')) {
        try {
          const results = await searchDuckDuckGo(seg, loc, VERBOSE);
          for (const r of results) {
            if (dedup.isDomainNew(r.website)) {
              dedup.registerDomain(r.website);
              companyQueue.push({ website: r.website, companyName: '', industry: seg.label, location: loc.label, source: 'duckduckgo' });
            }
          }
          if (results.length > 0) {
            console.log(chalk.green(`    DDG: ${seg.slug}/${loc.slug} — ${results.length} domains`));
          }
        } catch (err) {
          logError(`DDG ${seg.slug}/${loc.slug}: ${err.message}`);
        }
      }

      if (enabledSources.includes('bing')) {
        try {
          const results = await searchBing(seg, loc, VERBOSE);
          for (const r of results) {
            if (dedup.isDomainNew(r.website)) {
              dedup.registerDomain(r.website);
              companyQueue.push({ website: r.website, companyName: '', industry: seg.label, location: loc.label, source: 'bing' });
            }
          }
          if (results.length > 0) {
            console.log(chalk.green(`    Bing: ${seg.slug}/${loc.slug} — ${results.length} domains`));
          }
        } catch (err) {
          logError(`Bing ${seg.slug}/${loc.slug}: ${err.message}`);
        }
      }
    }
    console.log(chalk.gray(`    Queue: ${companyQueue.length} domains | Leads: ${leadCount}\n`));
  }

  // ═══════════════════════════════════
  // PHASE 2 — Website Email Extraction
  // ═══════════════════════════════════
  if (companyQueue.length > 0 && leadCount < TARGET) {
    console.log(chalk.bold.white(`\n[Phase 2] Extracting emails from ${companyQueue.length} websites...\n`));

    const siteLimit = pLimit(config.SITE_CONCURRENCY);
    const siteTasks = companyQueue.map(company =>
      siteLimit(async () => {
        if (leadCount >= TARGET) return;
        try {
          await randomDelay(config.SITE_DELAY_MIN, config.SITE_DELAY_MAX);
          const lead = await scrapeSite(company, VERBOSE);
          if (tryAddLead(lead)) {
            const symbol = lead.emailType === 'personal' ? chalk.green('✓') : chalk.yellow('~');
            const icp = lead.isICPSignal ? chalk.cyan(' [ICP]') : '';
            const domain = dedup.extractDomain(lead.website) || lead.website;
            const nameStr = lead.ownerName ? `, ${lead.ownerName}` : '';
            console.log(`  [${leadCount}/${TARGET}] ${symbol} ${domain} → ${lead.email} (${lead.companyName}${nameStr}, Q:${lead.qualityScore}/5)${icp}`);
          } else if (VERBOSE) {
            const domain = dedup.extractDomain(company.website) || company.website;
            console.log(`  [${leadCount}/${TARGET}] ${chalk.red('✗')} ${domain} — No email found`);
          }
        } catch (err) {
          logError(`Site ${company.website}: ${err.message}`);
          if (VERBOSE) console.log(`  ${chalk.red('✗')} ${company.website} — ${err.message}`);
        }
      })
    );

    await Promise.all(siteTasks);
    console.log(chalk.gray(`\n    Leads after Phase 2: ${leadCount}\n`));
  }

  // ═══════════════════════════════════
  // PHASE 3 — Fallback Queries
  // ═══════════════════════════════════
  if (leadCount < TARGET) {
    console.log(chalk.bold.white(`\n[Phase 3] Fallback queries (need ${TARGET - leadCount} more)...\n`));

    const fbSegments = targetSegments.slice(0, 8);
    const fbLocations = targetLocations.slice(0, 6);

    for (const seg of fbSegments) {
      for (const loc of fbLocations) {
        if (leadCount >= TARGET) break;

        const newDomains = [];

        if (enabledSources.includes('duckduckgo')) {
          try {
            for (const query of ddgFallback(seg, loc)) {
              const stub = { label: query, searchKeywords: [query] };
              const results = await searchDuckDuckGo(stub, loc, VERBOSE);
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

        if (enabledSources.includes('bing')) {
          try {
            for (const query of bingFallback(seg, loc)) {
              const stub = { label: query, searchKeywords: [query] };
              const results = await searchBing(stub, loc, VERBOSE);
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
          if (VERBOSE) console.log(chalk.blue(`  Fallback: ${seg.slug}/${loc.slug} — ${newDomains.length} new domains`));
          const siteLimit = pLimit(config.SITE_CONCURRENCY);
          const siteTasks = newDomains.map(company =>
            siteLimit(async () => {
              if (leadCount >= TARGET) return;
              try {
                await randomDelay(config.SITE_DELAY_MIN, config.SITE_DELAY_MAX);
                const lead = await scrapeSite(company, VERBOSE);
                if (tryAddLead(lead)) {
                  const symbol = lead.emailType === 'personal' ? chalk.green('✓') : chalk.yellow('~');
                  const domain = dedup.extractDomain(lead.website) || lead.website;
                  console.log(`  [${leadCount}/${TARGET}] ${symbol} ${domain} → ${lead.email} (Q:${lead.qualityScore}/5)`);
                }
              } catch (err) {
                logError(`Site ${company.website}: ${err.message}`);
              }
            })
          );
          await Promise.all(siteTasks);
        }
      }
      if (leadCount >= TARGET) break;
    }
  }

  // ═══════════════════════════════════
  // Summary
  // ═══════════════════════════════════
  csvWriter.close();

  const elapsed = Date.now() - startTime;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  const timeStr = hours > 0
    ? `${hours}h ${minutes}m`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  console.log(chalk.bold.white('\n' + '═'.repeat(48)));
  console.log(chalk.bold.cyan(`  Helix ICP Leads: ${leadCount}/${TARGET} complete`));
  console.log(chalk.white(`  Domains scraped: ${dedup.domainCount}`));
  console.log(chalk.white(`  Time elapsed: ${timeStr}`));
  console.log(chalk.white(`  Saved to: output/Helix Leads.csv`));
  console.log(chalk.bold.white('═'.repeat(48) + '\n'));

  if (leadCount < TARGET) {
    console.log(chalk.yellow(`  Note: Only ${leadCount} leads found. Try broader segments/regions or re-run with --resume.\n`));
  }

  process.exit(0);
}

main().catch(err => {
  console.error(chalk.red(`\nFatal error: ${err.message}`));
  logError(`FATAL: ${err.stack}`);
  process.exit(1);
});
