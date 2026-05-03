const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const config = require('./config');

const CSV_HEADERS = 'Email,Owner Name,Company Name,Website,Industry,Location,Email Type,Quality Score,Source\n';
const CSV_PATH = path.join(config.OUTPUT_DIR, 'Helix Leads.csv');

class CsvWriter {
  constructor() {
    this.leadCount = 0;
    this.fd = null;
  }

  init(resume = false) {
    // Ensure output dir exists
    if (!fs.existsSync(config.OUTPUT_DIR)) {
      fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
    }

    if (resume && fs.existsSync(CSV_PATH)) {
      // Append mode
      this.fd = fs.openSync(CSV_PATH, 'a');
    } else {
      // New file
      this.fd = fs.openSync(CSV_PATH, 'w');
      fs.writeSync(this.fd, CSV_HEADERS);
    }
  }

  escapeCsvField(field) {
    if (!field) return '';
    const str = String(field);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  writeLead(lead) {
    const row = [
      lead.email,
      lead.ownerName,
      lead.companyName,
      lead.website,
      lead.industry,
      lead.location,
      lead.emailType,
      lead.qualityScore,
      lead.source
    ].map(f => this.escapeCsvField(f)).join(',') + '\n';

    fs.writeSync(this.fd, row);
    this.leadCount++;
  }

  async loadExisting(deduplicator) {
    if (!fs.existsSync(CSV_PATH)) return 0;

    return new Promise((resolve, reject) => {
      let count = 0;
      fs.createReadStream(CSV_PATH)
        .pipe(csvParser())
        .on('data', (row) => {
          count++;
          if (row.Email) deduplicator.addEmail(row.Email);
          if (row.Website) deduplicator.registerDomain(row.Website);
        })
        .on('end', () => {
          this.leadCount = count;
          resolve(count);
        })
        .on('error', reject);
    });
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = CsvWriter;
