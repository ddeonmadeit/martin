#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs');
const { ScraperPipeline, industries, locations } = require('./src/pipeline');
const config = require('./src/config');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Current pipeline instance
let pipeline = null;
const sseClients = new Set();

// Broadcast to all SSE clients
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

// Wire pipeline events to SSE
function attachPipelineEvents(pl) {
  pl.on('progress', (status) => broadcast('progress', status));
  pl.on('lead', (lead) => broadcast('lead', lead));
  pl.on('log', (entry) => broadcast('log', entry));
  pl.on('done', (status) => broadcast('done', status));
  pl.on('error', (msg) => broadcast('error', { message: msg }));
}

// ── API Routes ──

// Get available industries and locations
app.get('/api/options', (req, res) => {
  res.json({ industries, locations });
});

// Get current status
app.get('/api/status', (req, res) => {
  if (!pipeline) {
    return res.json({ running: false, phase: 'idle', leadCount: 0, target: 0 });
  }
  res.json(pipeline.getStatus());
});

// Start scraping
app.post('/api/start', (req, res) => {
  if (pipeline && pipeline.running) {
    return res.status(409).json({ error: 'Scraper is already running' });
  }

  const {
    target = 2000,
    resume = false,
    sources = ['duckduckgo', 'bing'],
    industry = null,
    location = null
  } = req.body;

  pipeline = new ScraperPipeline({
    target: parseInt(target, 10) || 2000,
    resume,
    sources,
    industry,
    location,
    verbose: true
  });

  attachPipelineEvents(pipeline);

  // Run in background
  pipeline.run().catch(err => {
    console.error('Pipeline error:', err.message);
  });

  res.json({ message: 'Scraper started', target: pipeline.target });
});

// Stop scraping
app.post('/api/stop', (req, res) => {
  if (!pipeline || !pipeline.running) {
    return res.status(400).json({ error: 'Scraper is not running' });
  }
  pipeline.abort();
  res.json({ message: 'Stop requested' });
});

// Download CSV
app.get('/api/download', (req, res) => {
  const csvPath = path.join(config.OUTPUT_DIR, 'Helix Leads.csv');
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'No CSV file found. Run the scraper first.' });
  }
  res.download(csvPath, 'Helix Leads.csv');
});

// Get recent leads as JSON (for table)
app.get('/api/leads', (req, res) => {
  if (!pipeline) {
    return res.json({ leads: [] });
  }
  res.json({ leads: pipeline.recentLeads || [] });
});

// SSE endpoint for live updates
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

  // Send current status immediately
  if (pipeline) {
    res.write(`event: progress\ndata: ${JSON.stringify(pipeline.getStatus())}\n\n`);
  }

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Serve the dashboard for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Helix Scraper UI running at http://0.0.0.0:${PORT}\n`);
});
