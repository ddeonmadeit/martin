#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs');

const { ScraperPipeline, industries, locations } = require('./src/pipeline');
const config = require('./src/config');
const db = require('./src/database');
const EmailSender = require('./src/emailSender');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Scraper state ─────────────────────────────────────────────────────────────

let pipeline = null;
const scrapeSseClients = new Set();

function broadcastScrape(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of scrapeSseClients) res.write(msg);
}

function attachPipelineEvents(pl) {
  pl.on('progress', s  => broadcastScrape('progress', s));
  pl.on('lead',     l  => broadcastScrape('lead', l));
  pl.on('log',      e  => broadcastScrape('log', e));
  pl.on('done',     s  => broadcastScrape('done', s));
  pl.on('error',    m  => broadcastScrape('error', { message: m }));
}

// ── Email sender state ────────────────────────────────────────────────────────

let emailSender = new EmailSender();
const emailSseClients = new Set();

function broadcastEmail(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of emailSseClients) res.write(msg);
}

function attachEmailEvents(sender) {
  sender.on('start',  d => broadcastEmail('emailStart',  d));
  sender.on('sent',   d => broadcastEmail('emailSent',   d));
  sender.on('failed', d => broadcastEmail('emailFailed', d));
  sender.on('done',   d => broadcastEmail('emailDone',   d));
}

attachEmailEvents(emailSender);

// ════════════════════════════════════════════════════════════════════════════
// SCRAPER API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/options', (req, res) => {
  res.json({ industries, locations });
});

app.get('/api/status', (req, res) => {
  if (!pipeline) return res.json({ running: false, phase: 'idle', leadCount: 0, target: 0 });
  res.json(pipeline.getStatus());
});

app.post('/api/start', (req, res) => {
  if (pipeline && pipeline.running) {
    return res.status(409).json({ error: 'Scraper is already running' });
  }

  const {
    target     = 2000,
    resume     = false,
    sources    = ['duckduckgo', 'bing'],
    industry   = null,
    industries = null,
    location   = null,
    locations  = null,
    collect    = ['email'],
    orgType    = ['non-govt', 'for-profit'],
  } = req.body;

  pipeline = new ScraperPipeline({
    target:     parseInt(target, 10) || 2000,
    resume,
    sources,
    industries: industries || (industry ? [industry] : []),
    locations:  locations  || (location  ? [location]  : []),
    collect,
    orgType,
    verbose: true
  });

  attachPipelineEvents(pipeline);
  pipeline.run().catch(err => console.error('Pipeline error:', err.message));

  res.json({ message: 'Scraper started', target: pipeline.target });
});

app.post('/api/stop', (req, res) => {
  if (!pipeline || !pipeline.running) {
    return res.status(400).json({ error: 'Scraper is not running' });
  }
  pipeline.abort();
  res.json({ message: 'Stop requested' });
});

app.get('/api/download', (req, res) => {
  const csvPath = path.join(config.OUTPUT_DIR, 'Helix Leads.csv');
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'No CSV file found. Run the scraper first.' });
  }
  res.download(csvPath, 'Helix Leads.csv');
});

app.get('/api/leads', (req, res) => {
  res.json({ leads: pipeline ? (pipeline.recentLeads || []) : [] });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
  if (pipeline) {
    res.write(`event: progress\ndata: ${JSON.stringify(pipeline.getStatus())}\n\n`);
  }
  scrapeSseClients.add(res);
  req.on('close', () => scrapeSseClients.delete(res));
});

// ════════════════════════════════════════════════════════════════════════════
// DATABASE API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/db/stats', (req, res) => {
  try { res.json(db.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/leads', (req, res) => {
  const page    = parseInt(req.query.page,    10) || 1;
  const perPage = parseInt(req.query.perPage, 10) || 50;
  const status  = req.query.status || null;
  try { res.json(db.getAllLeads({ page, perPage, status })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// RESEND CONFIG API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/resend/config', (req, res) => {
  try {
    const cfg = db.getResendConfig();
    res.json({ ...cfg, api_key: cfg.api_key ? '••••••••' : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/resend/config', (req, res) => {
  try {
    db.saveResendConfig(req.body);
    res.json({ message: 'Resend config saved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/resend/test', async (req, res) => {
  try {
    await new EmailSender().testConnection();
    res.json({ message: 'Connection successful ✓' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// EMAIL TEMPLATE API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/resend/template', (req, res) => {
  try { res.json(db.getEmailTemplate()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/resend/template', (req, res) => {
  try {
    db.saveEmailTemplate(req.body);
    res.json({ message: 'Template saved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// EMAIL SEND API
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/email/status', (req, res) => {
  res.json({
    running: emailSender.running,
    sent:    emailSender.sent,
    failed:  emailSender.failed,
    total:   emailSender.total
  });
});

app.post('/api/email/send', async (req, res) => {
  if (emailSender.running) {
    return res.status(409).json({ error: 'Email sender is already running' });
  }
  const delayMs  = (parseInt(req.body.delaySeconds, 10) || 5) * 1000;
  const industry = req.body.industry || null;
  emailSender = new EmailSender();
  attachEmailEvents(emailSender);
  emailSender.sendToUnsent({ delayMs, industry }).catch(err => {
    broadcastEmail('emailError', { message: err.message });
  });
  res.json({ message: 'Email sending started' });
});

app.post('/api/email/stop', (req, res) => {
  emailSender.abort();
  res.json({ message: 'Stop requested' });
});

app.get('/api/email/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
  res.write(`event: emailStatus\ndata: ${JSON.stringify({
    running: emailSender.running,
    sent:    emailSender.sent,
    failed:  emailSender.failed,
    total:   emailSender.total
  })}\n\n`);
  emailSseClients.add(res);
  req.on('close', () => emailSseClients.delete(res));
});

// ════════════════════════════════════════════════════════════════════════════
// MAIL STUDIO API
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/mail/send-single', async (req, res) => {
  const { to, subject, html } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'to, subject and html are required' });
  }
  try {
    const cfg = db.getResendConfig();
    if (!cfg.api_key) throw new Error('Resend API key not configured');
    const { Resend } = require('resend');
    const resend = new Resend(cfg.api_key);
    const fromAddr = cfg.from_name ? `${cfg.from_name} <${cfg.from_email}>` : cfg.from_email;
    const { error } = await resend.emails.send({ from: fromAddr, to, subject, html });
    if (error) throw new Error(error.message || String(error));
    res.json({ message: 'Email sent' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/mail/send-bulk', async (req, res) => {
  const { recipients, subject, html } = req.body; // recipients: [{email, ...vars}]
  if (!recipients?.length || !subject || !html) {
    return res.status(400).json({ error: 'recipients, subject and html are required' });
  }
  try {
    const cfg = db.getResendConfig();
    if (!cfg.api_key) throw new Error('Resend API key not configured');
    const { Resend } = require('resend');
    const resend = new Resend(cfg.api_key);
    const fromAddr = cfg.from_name ? `${cfg.from_name} <${cfg.from_email}>` : cfg.from_email;
    let ok = 0, failed = 0;
    for (const r of recipients) {
      try {
        const filled = (s) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => r[k] ?? '');
        const { error } = await resend.emails.send({
          from: fromAddr, to: r.email,
          subject: filled(subject), html: filled(html),
        });
        if (error) throw new Error(error.message);
        ok++;
      } catch { failed++; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    res.json({ ok, failed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/mail/sent', (req, res) => {
  try { res.json(db.getSentEmails()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mail/templates', (req, res) => {
  try { res.json(db.getMailTemplates()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mail/templates', (req, res) => {
  try { db.saveMailTemplate(req.body); res.json({ message: 'Template saved' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/mail/templates/:id', (req, res) => {
  try { db.deleteMailTemplate(req.params.id); res.json({ message: 'Template deleted' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Helix Scraper UI running at http://0.0.0.0:${PORT}\n`);
});
