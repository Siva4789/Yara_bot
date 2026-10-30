require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const { createAgentTools } = require('./tools');
const { setupTelegramBot } = require('./telegram');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// List connected projects
app.get('/api/projects', (req, res) => {
  res.json({ projects: db.getProjects() });
});

// Add project
app.post('/api/projects', (req, res) => {
  const { id, name, projectPath, techStack } = req.body;
  const project = db.addProject({
    id: id || name.toLowerCase().replace(/\s+/g, '-'),
    name,
    path: projectPath,
    tech_stack: techStack || 'auto'
  });
  res.json({ success: true, project });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
  console.log(`[Platform Ready] Open http://localhost:${PORT} on your browser or mobile.`);
  
  // Initialize Telegram Bot
  const bot = setupTelegramBot();
  if (bot) {
    // Mount webhook handler
    app.use('/telegram-webhook', bot.webhookCallback('/telegram-webhook'));
    console.log('[Telegram Webhook] Listening on /telegram-webhook');
  }
});
