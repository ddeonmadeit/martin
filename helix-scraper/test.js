#!/usr/bin/env node

/**
 * Structural test — verifies all modules load, parse correctly,
 * and the pipeline logic works end-to-end with mock data.
 * Run: node test.js
 */

const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(chalk.green(`  PASS: ${name}`));
    passed++;
  } else {
    console.log(chalk.red(`  FAIL: ${name}`));
    failed++;
  }
}

console.log(chalk.bold('\nHelix Scraper — Structural Tests\n'));

// 1. Config loads
console.log(chalk.yellow('Config'));
const config = require('./src/config');
assert(config.DIRECTORY_DELAY_MIN > 0, 'DIRECTORY_DELAY_MIN is positive');
assert(config.SITE_CONCURRENCY > 0, 'SITE_CONCURRENCY is positive');
assert(config.FREE_EMAIL_DOMAINS.includes('gmail.com'), 'Free domains include gmail.com');
assert(config.JUNK_DOMAINS.includes('facebook.com'), 'Junk domains include facebook.com');
assert(config.HIGH_END_KEYWORDS.length > 5, 'Has high-end keywords');
assert(config.CONTACT_SUBPAGES.includes('/contact'), 'Has /contact subpage');

// 2. Data files load
console.log(chalk.yellow('\nData files'));
const industries = require('./data/industries.json');
const locations = require('./data/locations.json');
const userAgents = require('./data/userAgents.json');
assert(industries.categories.length > 30, `Industries: ${industries.categories.length} categories`);
assert(locations.locations.length >= 20, `Locations: ${locations.locations.length} cities`);
assert(userAgents.length >= 20, `User agents: ${userAgents.length} strings`);
assert(industries.categories[0].slug && industries.categories[0].label, 'Industry has slug and label');
assert(locations.locations[0].slug && locations.locations[0].label, 'Location has slug and label');

// 3. ProxyRotator
console.log(chalk.yellow('\nProxyRotator'));
const { getHeaders, randomDelay, getRandomUA } = require('./src/proxyRotator');
const headers = getHeaders();
assert(headers['User-Agent'].includes('Mozilla'), 'User-Agent is realistic');
assert(headers['Accept-Language'].startsWith('en-'), 'Accept-Language is set');
assert(headers['Sec-Fetch-Dest'] === 'document', 'Sec-Fetch headers present');
const ua1 = getRandomUA();
const ua2 = getRandomUA();
assert(ua1.length > 20, 'UA string is realistic length');

// 4. Quality Scorer
console.log(chalk.yellow('\nQuality Scorer'));
const { classifyEmail, isFreeDomain, scoreLead, detectHighEnd } = require('./src/qualityScorer');

assert(classifyEmail('john@company.com.au') === 'personal', 'john@ is personal');
assert(classifyEmail('info@company.com.au') === 'generic', 'info@ is generic');
assert(classifyEmail('noreply@company.com.au') === 'automated', 'noreply@ is automated');
assert(classifyEmail('j.smith@company.com.au') === 'personal', 'j.smith@ is personal');
assert(classifyEmail('sales@company.com.au') === 'generic', 'sales@ is generic');

assert(isFreeDomain('test@gmail.com') === true, 'gmail is free domain');
assert(isFreeDomain('test@company.com.au') === false, 'company.com.au is not free');
assert(isFreeDomain('test@hotmail.com') === true, 'hotmail is free domain');

assert(detectHighEnd('We are a luxury custom home builder') === true, 'Detects luxury');
assert(detectHighEnd('Commercial project management services') === true, 'Detects commercial');
assert(detectHighEnd('We fix taps and toilets') === false, 'No false positive on basic text');

const testLead = {
  email: 'john@example.com.au',
  ownerName: 'John Smith',
  companyName: 'Smith Builders',
  website: 'https://example.com.au',
  industry: 'Builders',
  location: 'Sydney',
  emailType: 'personal',
  isHighEnd: true
};
const score = scoreLead(testLead);
assert(score === 5, `Perfect lead scores 5 (got ${score})`);

const genericLead = {
  email: 'info@example.com',
  ownerName: '',
  companyName: 'Some Co',
  website: 'https://example.com',
  industry: '',
  location: 'Melbourne',
  emailType: 'generic',
  isHighEnd: false
};
const lowScore = scoreLead(genericLead);
assert(lowScore <= 2, `Low quality lead scores <= 2 (got ${lowScore})`);

// 5. Deduplicator
console.log(chalk.yellow('\nDeduplicator'));
const Deduplicator = require('./src/deduplicator');
const dedup = new Deduplicator();

assert(dedup.emailCount === 0, 'Starts empty');
dedup.addEmail('test@example.com');
assert(dedup.hasEmail('test@example.com'), 'Has added email');
assert(dedup.hasEmail('TEST@Example.com'), 'Case insensitive email match');
assert(!dedup.hasEmail('other@example.com'), 'Does not have unadded email');

const domain = dedup.extractDomain('https://www.example.com.au/page');
assert(domain === 'example.com.au', `Extracts domain: ${domain}`);
assert(dedup.isDomainNew('https://example.com.au'), 'New domain detected');
dedup.registerDomain('https://example.com.au');
assert(!dedup.isDomainNew('https://www.example.com.au'), 'Registered domain not new');
assert(dedup.domainCount === 1, 'Domain count is 1');

// 6. CSV Writer
console.log(chalk.yellow('\nCSV Writer'));
const CsvWriter = require('./src/csvWriter');
const csvWriter = new CsvWriter();

// Test escaping
assert(csvWriter.escapeCsvField('simple') === 'simple', 'Simple field not escaped');
assert(csvWriter.escapeCsvField('has, comma') === '"has, comma"', 'Comma field escaped');
assert(csvWriter.escapeCsvField('has "quotes"') === '"has ""quotes"""', 'Quotes escaped');
assert(csvWriter.escapeCsvField('') === '', 'Empty field ok');
assert(csvWriter.escapeCsvField(null) === '', 'Null field ok');

// Test writing
const testCsvPath = path.join(config.OUTPUT_DIR, 'test-output.csv');
csvWriter.init(false);
csvWriter.writeLead({
  email: 'john@test.com.au',
  ownerName: 'John Smith',
  companyName: 'Test Builders',
  website: 'https://test.com.au',
  industry: 'Builders',
  location: 'Sydney',
  emailType: 'personal',
  qualityScore: 5,
  source: 'yellowpages'
});
csvWriter.writeLead({
  email: 'info@another.com.au',
  ownerName: '',
  companyName: 'Another, Inc.',
  website: 'https://another.com.au',
  industry: 'Landscaping',
  location: 'Melbourne',
  emailType: 'generic',
  qualityScore: 2,
  source: 'truelocal'
});
csvWriter.close();
assert(csvWriter.leadCount === 2, 'Lead count is 2');

// Verify the CSV exists
const csvPath = path.join(config.OUTPUT_DIR, 'Helix Leads.csv');
assert(fs.existsSync(csvPath), 'CSV file was created');
const csvContent = fs.readFileSync(csvPath, 'utf-8');
assert(csvContent.includes('john@test.com.au'), 'CSV contains first email');
assert(csvContent.includes('"Another, Inc."'), 'CSV properly escapes commas');
assert(csvContent.startsWith('Email,Owner Name,'), 'CSV has correct headers');

// Test resume loading
const csvWriter2 = new CsvWriter();
const dedup2 = new Deduplicator();
csvWriter2.loadExisting(dedup2).then(count => {
  assert(count === 2, `Resume loads ${count} leads`);
  assert(dedup2.hasEmail('john@test.com.au'), 'Resume loaded email into dedup');

  // Cleanup test file
  fs.unlinkSync(csvPath);

  // 7. Site scraper email extraction
  console.log(chalk.yellow('\nSite Scraper'));
  const { extractEmails, filterEmails } = require('./src/siteScraper');

  const testHtml = `
    <html>
    <body>
      <p>Contact us at john@company.com.au or info@company.com.au</p>
      <a href="mailto:sales@company.com.au">Email sales</a>
      <p>You can also reach us at admin [at] company [dot] com [dot] au</p>
      <p>noreply@company.com.au</p>
      <p>test@gmail.com</p>
      <img src="banner@2x.png" />
      <link href="styles@media.css" />
    </body>
    </html>
  `;

  const emails = extractEmails(testHtml);
  assert(emails.includes('john@company.com.au'), 'Extracts plain email');
  assert(emails.includes('sales@company.com.au'), 'Extracts mailto email');
  assert(emails.includes('info@company.com.au'), 'Extracts second email');

  const filtered = filterEmails(emails);
  assert(!filtered.includes('noreply@company.com.au'), 'Filters automated emails');
  assert(!filtered.includes('test@gmail.com'), 'Filters free domain emails');
  assert(filtered.includes('john@company.com.au'), 'Keeps business emails');
  assert(!filtered.some(e => e.endsWith('.png')), 'Filters image filenames');
  assert(!filtered.some(e => e.endsWith('.css')), 'Filters CSS filenames');

  // 8. Module imports
  console.log(chalk.yellow('\nModule imports'));
  try {
    require('./src/scrapers/yellowPages');
    assert(true, 'yellowPages module loads');
  } catch (e) { assert(false, `yellowPages: ${e.message}`); }

  try {
    require('./src/scrapers/trueLocal');
    assert(true, 'trueLocal module loads');
  } catch (e) { assert(false, `trueLocal: ${e.message}`); }

  try {
    require('./src/scrapers/hotfrog');
    assert(true, 'hotfrog module loads');
  } catch (e) { assert(false, `hotfrog: ${e.message}`); }

  try {
    require('./src/scrapers/duckSearch');
    assert(true, 'duckSearch module loads');
  } catch (e) { assert(false, `duckSearch: ${e.message}`); }

  try {
    require('./src/scrapers/bingSearch');
    assert(true, 'bingSearch module loads');
  } catch (e) { assert(false, `bingSearch: ${e.message}`); }

  // 9. CLI parsing
  console.log(chalk.yellow('\nCLI'));
  assert(fs.existsSync(path.join(__dirname, 'index.js')), 'index.js exists');
  const indexContent = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf-8');
  assert(indexContent.includes('--target'), 'CLI has --target option');
  assert(indexContent.includes('--resume'), 'CLI has --resume option');
  assert(indexContent.includes('--sources'), 'CLI has --sources option');
  assert(indexContent.includes('--industry'), 'CLI has --industry option');
  assert(indexContent.includes('--location'), 'CLI has --location option');
  assert(indexContent.includes('--verbose'), 'CLI has --verbose option');
  assert(indexContent.includes('Phase 1'), 'Has Phase 1');
  assert(indexContent.includes('Phase 2'), 'Has Phase 2');
  assert(indexContent.includes('Phase 3'), 'Has Phase 3');

  // Summary
  console.log(chalk.bold(`\n${'═'.repeat(42)}`));
  console.log(chalk.bold(`  Results: ${passed} passed, ${failed} failed`));
  console.log(chalk.bold(`${'═'.repeat(42)}\n`));

  if (failed > 0) process.exit(1);
});
