const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const { createAgentTools } = require('./tools');
const { startCloudflareTunnel } = require('./tunnel');

const pendingPlans = {};

function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUser = process.env.TELEGRAM_ALLOWED_USER_ID;

  if (!token) return null;

  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    const fromId = ctx.from && ctx.from.id ? ctx.from.id.toString() : '';
    if (allowedUser && fromId !== allowedUser.toString()) {
      return ctx.reply('⛔ Unauthorized. This bot is locked to its owner.');
    }
    return next();
  });

  bot.command('addproject', async (ctx) => {
    const text = ctx.message.text.replace('/addproject', '').trim();
    if (!text) {
      return ctx.reply('Usage: /addproject <name> <folder_path>');
    }
    const parts = text.split(' ');
    const name = parts[0];
    const projectPath = parts.slice(1).join(' ').trim();

    if (!fs.existsSync(projectPath)) {
      return ctx.reply(`⚠️ Folder path does not exist on your laptop:\n\`${projectPath}\``, { parse_mode: 'Markdown' });
    }

    db.addProject({
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name: name,
      path: projectPath,
      tech_stack: 'auto'
    });

    ctx.reply(`✅ *Project Connected!* 🎉\n📌 Name: \`${name}\`\n📁 Path: \`${projectPath}\``, { parse_mode: 'Markdown' });
  });

  bot.command('start', async (ctx) => {
    const projects = db.getProjects();
    let msg = `👋 Welcome to your *Personal AI Developer*!\n\n`;
    if (projects.length === 0) {
      msg += `📁 No projects connected yet.\nUse \`/addproject <name> <path>\` to connect.`;
    } else {
      msg += `📁 *Connected Projects:*\n`;
      projects.forEach((p, idx) => {
        msg += `${idx + 1}. \`${p.name}\` (${p.path})\n`;
      });
      msg += `\nSend: \`/task <project_name> <instruction>\` to work on code!`;
    }
    ctx.replyWithMarkdown(msg);
  });

  bot.command('task', async (ctx) => {
    const text = ctx.message.text.replace('/task', '').trim();
    if (!text) return ctx.reply('Usage: /task <project_name> <instruction>');

    const parts = text.split(' ');
    const projectName = parts[0];
    const prompt = parts.slice(1).join(' ');

    const projects = db.getProjects();
    const project = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase() || p.id === projectName.toLowerCase());

    if (!project) return ctx.reply(`❌ Project "${projectName}" not found.`);

    ctx.reply(`⚡ Analyzing task for \`${project.name}\`...\n📝 "${prompt}"`, { parse_mode: 'Markdown' });

    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
      const tools = createAgentTools(project.path);

      const files = await tools.listFiles({});
      const promptMsg = `You are an autonomous AI software engineer.
Project: ${project.name}
Files in root: ${JSON.stringify(files.map(f => f.name))}
User Request: "${prompt}"

Provide a concise technical plan. What files should be created or edited?`;

      const result = await model.generateContent(promptMsg);
      const plan = result.response.text();

      pendingPlans[project.id] = { project, prompt, plan };

      ctx.reply(`📋 AI Developer Plan:\n\n${plan.slice(0, 3000)}`, Markup.inlineKeyboard([
        [Markup.button.callback('⚡ Execute & Write Code Now', `exec_${project.id}`)],
        [Markup.button.callback('❌ Discard', 'cancel')]
      ]));
    } catch (err) {
      ctx.reply(`⚠️ Error: ${err.message}`);
    }
  });

  bot.on('callback_query', async (ctx) => {
    const action = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (action === 'cancel') return ctx.reply('❌ Task cancelled.');

    if (action.startsWith('exec_')) {
      const projectId = action.replace('exec_', '');
      const taskData = pendingPlans[projectId];
      if (!taskData) return ctx.reply('⚠️ No pending task found.');

      const { project, prompt, plan } = taskData;
      ctx.reply(`🚀 Reading existing files and applying changes safely to \`${project.name}\`...`, { parse_mode: 'Markdown' });

      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
        const tools = createAgentTools(project.path);

        // Find primary file to edit
        let existingContent = '';
        let targetFile = 'public/index.html';
        try {
          existingContent = await tools.readFile({ filepath: targetFile });
        } catch (e) {
          existingContent = '';
        }

        const editPrompt = `You are a careful software developer modifying existing code.
File: "${targetFile}"
Existing code:
${existingContent}

User Request: "${prompt}"

CRITICAL RULES:
1. PRESERVE all existing layouts, Tailwind styling, buttons, feeds, and JavaScript logic.
2. DO NOT delete or replace the existing UI with an empty or minimal skeleton.
3. Integrate the requested feature seamlessly into the existing file.
4. Return ONLY valid JSON:
{
  "filepath": "${targetFile}",
  "content": "THE COMPLETE UPDATED CODE PRESERVING EXISTING FEATURES",
  "summary": "What was added/changed"
}`;

        ctx.reply('✍️ Writing updated code...');
        const result = await model.generateContent(editPrompt);
        let rawText = result.response.text().trim();

        if (rawText.includes('```json')) {
          rawText = rawText.split('```json')[1].split('```')[0].trim();
        } else if (rawText.includes('```')) {
          rawText = rawText.split('```')[1].split('```')[0].trim();
        }

        const change = JSON.parse(rawText);
        if (change.filepath && change.content) {
          await tools.writeFile({ filepath: change.filepath, content: change.content });

          ctx.reply('🚀 Generating secure Cloudflare live preview link for your phone...');
          const previewUrl = await startCloudflareTunnel(4005);

          ctx.reply(`🎉 Changes successfully applied!\n\n📄 File: ${change.filepath}\n📝 Summary: ${change.summary || 'Updated'}\n\n🌐 Live Mobile Preview:\n${previewUrl}`, Markup.inlineKeyboard([
            [Markup.button.url('🌐 Open Live App on Phone (Anywhere)', previewUrl)]
          ]));
        } else {
          ctx.reply('⚠️ Could not parse code update.');
        }

        delete pendingPlans[projectId];
      } catch (err) {
        ctx.reply(`⚠️ Execution error: ${err.message}`);
      }
    }
  });

  bot.launch().catch(e => console.error(e));
  return bot;
}

module.exports = { setupTelegramBot };
