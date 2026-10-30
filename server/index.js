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

// Run AI Task
app.post('/api/tasks/run', async (req, res) => {
  const { projectId, prompt } = req.body;
  const projects = db.getProjects();
  const project = projects.find(p => p.id === projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const taskId = 'task_' + Date.now();
  db.addTask({ id: taskId, project_id: projectId, prompt, status: 'running' });

  res.json({ success: true, taskId, message: 'Agent started' });

  // Autonomous loop execution
  runAutonomousAgent(taskId, project, prompt);
});

async function runAutonomousAgent(taskId, project, prompt) {
  broadcast({ type: 'task_start', taskId, prompt, projectName: project.name });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes('your_gemini_api_key')) {
    broadcast({ type: 'error', message: 'GEMINI_API_KEY is not configured in .env file.' });
    return;
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });
    const tools = createAgentTools(project.path);

    broadcast({ type: 'log', message: `🔍 Inspecting directory: ${project.path}` });
    const files = await tools.listFiles({});
    broadcast({ type: 'log', message: `Found ${files.length} top-level files/directories` });

    const systemPrompt = `You are an autonomous AI software developer working directly on the project: "${project.name}".
Available files in root: ${JSON.stringify(files.map(f => f.name))}
User Request: "${prompt}"

Provide a structured, step-by-step implementation plan and the exact files you will inspect or create.`;

    broadcast({ type: 'log', message: '🧠 Gemini is reasoning about the implementation...' });
    const result = await model.generateContent(systemPrompt);
    const textResponse = result.response.text();

    broadcast({ type: 'plan_ready', taskId, plan: textResponse });
    broadcast({ type: 'log', message: '✅ Task plan generated successfully' });
  } catch (err) {
    broadcast({ type: 'error', message: `Agent Error: ${err.message}` });
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'info', message: '⚡ Connected to Mobile AI Dev Control Center' }));
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[Platform Ready] Open http://localhost:${PORT} on your browser or mobile.`);
  const bot = setupTelegramBot();
  if (bot) {
    app.use(bot.webhookCallback('/telegram-webhook'));
    console.log('[Telegram Webhook] Listening on /telegram-webhook');
  }
});
