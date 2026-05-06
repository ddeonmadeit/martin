const { Resend } = require('resend');
const EventEmitter = require('events');
const {
  getResendConfig,
  getEmailTemplate,
  getUnsentLeads,
  markEmailSent,
  markEmailFailed
} = require('./database');

function renderTemplate(tpl, vars) {
  return tpl
    .replace(/\{\{firstName\}\}/g,   vars.firstName   || 'there')
    .replace(/\{\{ownerName\}\}/g,   vars.ownerName   || 'there')
    .replace(/\{\{companyName\}\}/g, vars.companyName || 'your company')
    .replace(/\{\{website\}\}/g,     vars.website     || '')
    .replace(/\{\{industry\}\}/g,    vars.industry    || '')
    .replace(/\{\{location\}\}/g,    vars.location    || '');
}

function extractFirstName(ownerName) {
  if (!ownerName || !ownerName.trim()) return '';
  return ownerName.trim().split(/\s+/)[0];
}

class EmailSender extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.aborted = false;
    this.sent    = 0;
    this.failed  = 0;
    this.total   = 0;
  }

  abort() { this.aborted = true; }

  async testConnection() {
    const cfg = getResendConfig();
    if (!cfg.api_key) throw new Error('Resend API key is required');
    const resend = new Resend(cfg.api_key);
    const { data, error } = await resend.domains.list();
    if (error) throw new Error(error.message || 'Invalid API key');
    return data;
  }

  async sendToUnsent({ delayMs = 5000, industry = null } = {}) {
    if (this.running) throw new Error('Email sender is already running');

    const cfg      = getResendConfig();
    const template = getEmailTemplate();

    if (!cfg.api_key)    throw new Error('Resend API key not configured');
    if (!cfg.from_email) throw new Error('From email not configured');
    if (!template.subject || !template.body) {
      throw new Error('Email template is empty — write a subject and body first');
    }

    const leads = getUnsentLeads(industry);
    if (leads.length === 0) {
      this.emit('done', { sent: 0, failed: 0, total: 0, aborted: false });
      return;
    }

    this.running = true;
    this.aborted = false;
    this.sent    = 0;
    this.failed  = 0;
    this.total   = leads.length;

    this.emit('start', { total: this.total });

    const resend   = new Resend(cfg.api_key);
    const fromAddr = cfg.from_name ? `${cfg.from_name} <${cfg.from_email}>` : cfg.from_email;

    for (const lead of leads) {
      if (this.aborted) break;

      const vars = {
        firstName:   extractFirstName(lead.owner_name),
        ownerName:   lead.owner_name   || '',
        companyName: lead.company_name || '',
        website:     lead.website      || '',
        industry:    lead.industry     || '',
        location:    lead.location     || ''
      };

      const subject  = renderTemplate(template.subject, vars);
      const bodyText = renderTemplate(template.body, vars);
      const bodyHtml = bodyText.replace(/\n/g, '<br>');

      const { data, error } = await resend.emails.send({
        from: fromAddr, to: lead.email, subject, text: bodyText, html: bodyHtml
      });

      if (error) {
        markEmailFailed(lead.email, error.message || String(error));
        this.failed++;
        this.emit('failed', { email: lead.email, error: error.message || String(error), sent: this.sent, failed: this.failed, total: this.total });
      } else {
        markEmailSent(lead.email);
        this.sent++;
        this.emit('sent', { email: lead.email, company: lead.company_name, sent: this.sent, failed: this.failed, total: this.total });
      }

      if (!this.aborted && lead !== leads[leads.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    this.running = false;
    this.emit('done', { sent: this.sent, failed: this.failed, total: this.total, aborted: this.aborted });
  }
}

module.exports = EmailSender;
