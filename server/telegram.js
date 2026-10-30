const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const { createAgentTools } = require('./tools');

const pendingPlans = {};
const CLOUD_WORKSPACE_DIR = path.join(process.cwd(), 'workspaces');

if (!fs.existsSync(CLOUD_WORKSPACE_DIR)) {
  fs.mkdirSync(CLOUD_WORKSPACE_DIR, { recursive: true });
}

function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUser = process.env.TELEGRAM_ALLOWED_USER_ID;

  if (!token) return null;

  const bot = new Telegraf(token, { handlerTimeout: 900000 });

  bot.use(async (ctx, next) => {
    const fromId = ctx.from && ctx.from.id ? ctx.from.id.toString() : '';
    if (allowedUser && fromId !== allowedUser.toString()) {
      return ctx.reply('Unauthorized. This bot is locked to its owner.');
    }
    return next();
  });

  bot.command('addproject', async (ctx) => {
    const text = ctx.message.text.replace('/addproject', '').trim();
    if (!text) {
      return ctx.reply('Usage: /addproject <name> <folder_path_or_github_url>');
    }

    const parts = text.split(' ');
    const name = parts[0];
    const target = parts.slice(1).join(' ').trim();

    let projectPath = target;
    let isGitHub = false;

    if (target.startsWith('http://') || target.startsWith('https://')) {
      isGitHub = true;
      projectPath = path.join(CLOUD_WORKSPACE_DIR, name);

      ctx.reply(`Fetching repository from GitHub: ${target}`);

      try {
        if (fs.existsSync(projectPath)) {
          await simpleGit(projectPath).pull();
        } else {
          await simpleGit().clone(target, projectPath);
        }
      } catch (err) {
        return ctx.reply(`Failed to clone repository from GitHub:\n${err.message}`);
      }
    } else {
      if (!fs.existsSync(projectPath)) {
        return ctx.reply(`Local folder does not exist:\n${projectPath}`);
      }
    }

    db.addProject({
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name: name,
      path: projectPath,
      git_url: isGitHub ? target : null,
      tech_stack: 'auto'
    });

    ctx.reply(`Project Connected!\n\nName: ${name}\nWorkspace: ${projectPath}${isGitHub ? '\nSource: GitHub Repository' : ''}\n\nYou can now send tasks using:\n/task ${name} your instruction`);
  });

  bot.command('start', async (ctx) => {
    const projects = db.getProjects();
    let msg = `Welcome to your Personal AI Developer!\n\n`;
    if (projects.length === 0) {
      msg += `No projects connected yet.\nUse /addproject <name> <path_or_github_url> to connect.`;
    } else {
      msg += `Connected Projects:\n`;
      projects.forEach((p, idx) => {
        msg += `${idx + 1}. ${p.name} (${p.path})\n`;
      });
      msg += `\nSend: /task <project_name> <instruction> to start developing!`;
    }
    ctx.reply(msg);
  });

  bot.command('projects', async (ctx) => {
    const projects = db.getProjects();
    if (projects.length === 0) return ctx.reply('No projects connected yet.');
    const buttons = projects.map(p => [Markup.button.callback(`${p.name}`, `select_${p.id}`)]);
    ctx.reply('Select a project to work on:', Markup.inlineKeyboard(buttons));
  });

  bot.command('task', async (ctx) => {
    const text = ctx.message.text.replace('/task', '').trim();
    if (!text) return ctx.reply('Usage: /task <project_name> <instruction>');

    const parts = text.split(' ');
    const projectName = parts[0];
    const prompt = parts.slice(1).join(' ');

    const projects = db.getProjects();
    const project = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase() || p.id === projectName.toLowerCase());

    if (!project) return ctx.reply(`Project "${projectName}" not found. Use /projects to list all.`);

    ctx.reply(`Analyzing task for ${project.name}...\nInstruction: "${prompt}"`);

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

      ctx.reply(`AI Developer Plan:\n\n${plan.slice(0, 3000)}`, Markup.inlineKeyboard([
        [Markup.button.callback('Execute & Write Code Now', `exec_${project.id}`)],
        [Markup.button.callback('Discard', 'cancel')]
      ]));
    } catch (err) {
      ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.on('callback_query', async (ctx) => {
    const action = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (action === 'cancel') return ctx.reply('Task cancelled.');

    if (action.startsWith('exec_')) {
      const projectId = action.replace('exec_', '');
      const taskData = pendingPlans[projectId];
      if (!taskData) return ctx.reply('No pending task found.');

      const { project, prompt, plan } = taskData;
      ctx.reply(`Reading files and applying changes safely to ${project.name}...`);

      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
        const tools = createAgentTools(project.path);

        const rootFiles = await tools.listFiles({});
        let targetFile = 'index.html';
        
        const subfolder = rootFiles.find(f => f.isDirectory && f.name.includes('portfolio'));
        if (subfolder) {
          targetFile = `${subfolder.name}/index.html`;
        } else if (fs.existsSync(path.join(project.path, 'public', 'index.html'))) {
          targetFile = 'public/index.html';
        }

        let existingContent = '';
        try {
          existingContent = await tools.readFile({ filepath: targetFile });
        } catch (e) {
          existingContent = '';
        }

        const editPrompt = `You are an expert web developer modifying an existing project.
File to edit: "${targetFile}"
Existing code:
${existingContent.slice(0, 7000)}

User Request: "${prompt}"

CRITICAL RULES:
1. PRESERVE all existing HTML structure, CSS styles, scripts, and content.
2. DO NOT delete anything from the user's existing portfolio.
3. Add the requested feature seamlessly with appropriate CSS/JS.
4. Return ONLY valid JSON:
{
  "filepath": "${targetFile}",
  "content": "THE ENTIRE UPDATED FILE INCLUDING THE NEW FEATURE",
  "summary": "Brief explanation of what was added"
}`;

        ctx.reply('Generating updated code...');
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

          // Authenticated push directly using Classic Token!
          const ghToken = process.env.GITHUB_TOKEN;
          if (project.git_url && ghToken) {
            ctx.reply('Pushing changes to GitHub...');
            try {
              const git = simpleGit(project.path);
              await git.addConfig('user.name', 'Siva4789');
              await git.addConfig('user.email', 'siva03286@gmail.com');
              await git.add('.');
              await git.commit('Update from AI Developer: ' + (change.summary || 'Feature update'));

              const cleanUrl = project.git_url.replace('https://', '');
              const authUrl = `https://${ghToken}@${cleanUrl}`;
              await git.push(authUrl, 'main');
              ctx.reply('Successfully pushed to GitHub! Hosting is auto-deploying your live site.');
            } catch (gitErr) {
              ctx.reply(`Git Note: ${gitErr.message}`);
            }
          }

          ctx.reply(`Changes successfully applied!\n\nFile: ${change.filepath}\nSummary: ${change.summary || 'Updated'}\n\nLive site will update in ~15 seconds!`);
        } else {
          ctx.reply('Could not parse code output.');
        }

        delete pendingPlans[projectId];
      } catch (err) {
        ctx.reply(`Execution error: ${err.message}`);
      }
    }
  });

  return bot;
}

module.exports = { setupTelegramBot };
