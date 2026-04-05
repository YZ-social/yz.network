#!/usr/bin/env node

/**
 * Test server for Playwright browser tests
 * Serves the built application on port 3000
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from dist directory
const distPath = path.join(__dirname, '..', 'dist');

// Health check endpoint (must be before static/catch-all routes)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(express.static(distPath));

// Serve index.html for all routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Test server running on http://localhost:${PORT}`);
  console.log(`Serving files from: ${distPath}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Test server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Test server closed');
    process.exit(0);
  });
});

export default server;