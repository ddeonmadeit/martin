const nodemailer = require('nodemailer');
const EventEmitter = require('events');
const {
  getSmtpConfig,
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

function buildTransporter(cfg) {
  return nodemailer.createTransport({
    host:   cfg.host,
    port:   parseInt(cfg.port, 10),
    secure: cfg.secure === 1 || cfg.secure === true,
    auth:   { user: cfg.user, pass: cfg.pass },
    tls:    { rejectUnauthorized: false }
  });
}

class EmailSender extends EventEmitter {
  constructor() {
    super();
    this.running  = false;
    this.aborted  = false;
    this.sent     = 0;
    this.failed   = 0;
    this.total    = 0;
  }

  abort() {
    this.aborted = true;
  }

  async testConnection() {
    const cfg = getSmtpConfig();
    if (!cfg.host || !cfg.user) throw new Error('SMTP host and username are required');
    const transport = buildTransporter(cfg);
    await transport.verify();
  }

  async sendToUnsent({ delayMs = 5000 } = {}) {
    if (this.running) throw new Error('Email sender is already running');

    const cfg      = getSmtpConfig();
    const template = getEmailTemplate();

    if (!cfg.host || !cfg.user || !cfg.pass) {
      throw new Error('SMTP not fully configured — set host, user and password first');
    }
    if (!template.subject || !template.body) {
      throw new Error('Email template is empty — write a subject and body first');
    }

    const leads = getUnsentLeads();
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

    const transport = buildTransporter(cfg);

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

      const subject = renderTemplate(template.subject, vars);
      const body    = renderTemplate(template.body, vars);

      try {
        await transport.sendMail({
          from:    `"${cfg.from_name}" <${cfg.from_email || cfg.user}>`,
          to:      lead.email,
          subject,
          text:    body,
          html:    body.replace(/\n/g, '<br>')
        });

        markEmailSent(lead.email);
        this.sent++;
        this.emit('sent', {
          email:   lead.email,
          company: lead.company_name,
          sent:    this.sent,
          failed:  this.failed,
          total:   this.total
        });
      } catch (err) {
        markEmailFailed(lead.email, err.message);
        this.failed++;
        this.emit('failed', {
          email:  lead.email,
          error:  err.message,
          sent:   this.sent,
          failed: this.failed,
          total:  this.total
        });
      }

      if (!this.aborted && lead !== leads[leads.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    this.running = false;
    this.emit('done', {
      sent:    this.sent,
      failed:  this.failed,
      total:   this.total,
      aborted: this.aborted
    });
  }
}

module.exports = EmailSender;
