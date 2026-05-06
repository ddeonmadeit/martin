const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const DB_PATH = path.join(config.OUTPUT_DIR, 'helix.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(config.OUTPUT_DIR)) {
    fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  }
  _db = new BetterSqlite3(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _initSchema(_db);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE NOT NULL,
      owner_name    TEXT    DEFAULT '',
      company_name  TEXT    DEFAULT '',
      website       TEXT    DEFAULT '',
      industry      TEXT    DEFAULT '',
      location      TEXT    DEFAULT '',
      email_type    TEXT    DEFAULT 'generic',
      quality_score INTEGER DEFAULT 1,
      source        TEXT    DEFAULT '',
      icp_signal    INTEGER DEFAULT 0,
      scraped_at    TEXT    DEFAULT (datetime('now')),
      email_status  TEXT    DEFAULT 'unsent',
      email_sent_at TEXT    DEFAULT NULL,
      email_error   TEXT    DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS resend_config (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      api_key    TEXT    DEFAULT '',
      from_name  TEXT    DEFAULT '',
      from_email TEXT    DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS email_template (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      subject TEXT DEFAULT '',
      body    TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS mail_templates (
      id           TEXT    PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name         TEXT    NOT NULL,
      subject      TEXT    DEFAULT '',
      body_html    TEXT    DEFAULT '',
      font_family  TEXT    DEFAULT '',
      text_color   TEXT    DEFAULT '#e8edf2',
      bg_color     TEXT    DEFAULT '#0b0f1a',
      card_color   TEXT    DEFAULT '#111827',
      accent_color TEXT    DEFAULT '#22d3ee',
      show_logo    INTEGER DEFAULT 1,
      show_footer  INTEGER DEFAULT 1,
      created_at   TEXT    DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`INSERT OR IGNORE INTO resend_config (id, from_name, from_email) VALUES (1, 'Martin', 'martin@preemo.club')`).run();
  db.prepare(`INSERT OR IGNORE INTO email_template (id) VALUES (1)`).run();

  // Migrations: add new columns if not present
  const cols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  if (!cols.includes('phone'))            db.exec(`ALTER TABLE leads ADD COLUMN phone TEXT DEFAULT ''`);
  if (!cols.includes('instagram_handle')) db.exec(`ALTER TABLE leads ADD COLUMN instagram_handle TEXT DEFAULT ''`);
}

// ── Leads ────────────────────────────────────────────────────────────────────

function upsertLead(lead) {
  return getDb().prepare(`
    INSERT OR IGNORE INTO leads
      (email, owner_name, company_name, website, industry, location,
       email_type, quality_score, source, icp_signal, phone, instagram_handle)
    VALUES
      (@email, @owner_name, @company_name, @website, @industry, @location,
       @email_type, @quality_score, @source, @icp_signal, @phone, @instagram_handle)
  `).run({
    email:            lead.email,
    owner_name:       lead.ownerName        || '',
    company_name:     lead.companyName      || '',
    website:          lead.website          || '',
    industry:         lead.industry         || '',
    location:         lead.location         || '',
    email_type:       lead.emailType        || 'generic',
    quality_score:    lead.qualityScore     || 1,
    source:           lead.source           || '',
    icp_signal:       lead.isICPSignal      ? 1 : 0,
    phone:            lead.phone            || '',
    instagram_handle: lead.instagramHandle  || '',
  });
}

function getStats() {
  const db = getDb();
  const total  = db.prepare(`SELECT COUNT(*) AS n FROM leads`).get().n;
  const sent   = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE email_status = 'sent'`).get().n;
  const failed = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE email_status = 'failed'`).get().n;
  return { total, sent, failed, unsent: total - sent - failed };
}

function getAllLeads({ page = 1, perPage = 50, status = null } = {}) {
  const db     = getDb();
  const offset = (page - 1) * perPage;
  const where  = status ? `WHERE email_status = ?` : '';
  const args   = status ? [status] : [];

  const items = db.prepare(
    `SELECT * FROM leads ${where} ORDER BY scraped_at DESC LIMIT ? OFFSET ?`
  ).all(...args, perPage, offset);

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM leads ${where}`
  ).get(...args).n;

  return { items, total, page, perPage, pages: Math.ceil(total / perPage) };
}

function getUnsentLeads(industry = null) {
  if (industry) {
    return getDb().prepare(
      `SELECT * FROM leads WHERE email_status = 'unsent' AND industry LIKE ? ORDER BY quality_score DESC, id ASC`
    ).all(`%${industry}%`);
  }
  return getDb().prepare(
    `SELECT * FROM leads WHERE email_status = 'unsent' ORDER BY quality_score DESC, id ASC`
  ).all();
}

function markEmailSent(email) {
  getDb().prepare(
    `UPDATE leads SET email_status = 'sent', email_sent_at = datetime('now'), email_error = NULL WHERE email = ?`
  ).run(email);
}

function markEmailFailed(email, error) {
  getDb().prepare(
    `UPDATE leads SET email_status = 'failed', email_error = ? WHERE email = ?`
  ).run(String(error).slice(0, 500), email);
}

// ── Resend Config ─────────────────────────────────────────────────────────────

function getResendConfig() {
  const row = getDb().prepare(`SELECT * FROM resend_config WHERE id = 1`).get();
  return {
    api_key:    process.env.RESEND_API_KEY    || row.api_key    || '',
    from_name:  process.env.RESEND_FROM_NAME  || row.from_name  || 'Martin',
    from_email: process.env.RESEND_FROM_EMAIL || row.from_email || 'martin@preemo.club',
  };
}

function saveResendConfig({ api_key, from_name, from_email }) {
  const existing = getDb().prepare(`SELECT * FROM resend_config WHERE id = 1`).get();
  getDb().prepare(
    `UPDATE resend_config SET api_key = @api_key, from_name = @from_name, from_email = @from_email WHERE id = 1`
  ).run({
    api_key:    (api_key && api_key !== '••••••••') ? api_key : existing.api_key,
    from_name:  from_name  || 'Martin',
    from_email: from_email || 'martin@preemo.club'
  });
}

// ── Email Template ────────────────────────────────────────────────────────────

function getEmailTemplate() {
  return getDb().prepare(`SELECT * FROM email_template WHERE id = 1`).get();
}

function saveEmailTemplate({ subject, body }) {
  getDb().prepare(
    `UPDATE email_template SET subject = @subject, body = @body WHERE id = 1`
  ).run({ subject: subject || '', body: body || '' });
}

// ── Mail Templates ────────────────────────────────────────────────────────────

function getMailTemplates() {
  return getDb().prepare(`SELECT * FROM mail_templates ORDER BY created_at DESC`).all();
}

function saveMailTemplate(t) {
  return getDb().prepare(`
    INSERT INTO mail_templates
      (name, subject, body_html, font_family, text_color, bg_color, card_color, accent_color, show_logo, show_footer)
    VALUES
      (@name, @subject, @body_html, @font_family, @text_color, @bg_color, @card_color, @accent_color, @show_logo, @show_footer)
  `).run({
    name:         t.name         || '',
    subject:      t.subject      || '',
    body_html:    t.body_html    || '',
    font_family:  t.font_family  || '',
    text_color:   t.text_color   || '#e8edf2',
    bg_color:     t.bg_color     || '#0b0f1a',
    card_color:   t.card_color   || '#111827',
    accent_color: t.accent_color || '#22d3ee',
    show_logo:    t.show_logo    ? 1 : 0,
    show_footer:  t.show_footer  ? 1 : 0,
  });
}

function deleteMailTemplate(id) {
  return getDb().prepare(`DELETE FROM mail_templates WHERE id = ?`).run(id);
}

function getSentEmails(limit = 200) {
  return getDb().prepare(`
    SELECT email AS to_email, company_name, '' AS subject, email_sent_at AS created_at, email_status AS status
    FROM leads WHERE email_status IN ('sent','failed')
    ORDER BY email_sent_at DESC LIMIT ?
  `).all(limit);
}

function getDistinctIndustries() {
  return getDb().prepare(
    `SELECT DISTINCT industry FROM leads WHERE industry != '' ORDER BY industry ASC`
  ).all().map(r => r.industry);
}

module.exports = {
  getDb,
  upsertLead,
  getStats,
  getAllLeads,
  getUnsentLeads,
  markEmailSent,
  markEmailFailed,
  getResendConfig,
  saveResendConfig,
  getEmailTemplate,
  saveEmailTemplate,
  getMailTemplates,
  saveMailTemplate,
  deleteMailTemplate,
  getSentEmails,
  getDistinctIndustries,
};
