const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const { createAgentTools } = require('./tools');
const { startCloudflareTunnel } = require('./tunnel');

const pendingPlans = {};
const CLOUD_WORKSPACE_DIR = path.join(process.cwd(), 'workspaces');

// Ensure workspaces folder exists
if (!fs.existsSync(CLOUD_WORKSPACE_DIR)) {
  fs.mkdirSync(CLOUD_WORKSPACE_DIR, { recursive: true });
}

function setupTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUser = process.env.TELEGRAM_ALLOWED_USER_ID;

  if (!token) return null;

  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    const fromId = ctx.from && ctx.from.id ? ctx.from.id.toString() : '';
    if (allowedUser && fromId !== allowedUser.toString()) {
      return ctx.reply('â›” Unauthorized. This bot is locked to its owner.');
    }
    return next();
  });

  // /addproject: Supports BOTH Local Folders AND GitHub Clone URLs!
  bot.command('addproject', async (ctx) => {
    const text = ctx.message.text.replace('/addproject', '').trim();
    if (!text) {
      return ctx.reply('Usage: /addproject <name> <folder_path_or_github_url>\n\nExample:\n/addproject portfolio https://github.com/Siva4789/portfolionew.git');
    }

    const parts = text.split(' ');
    const name = parts[0];
    const target = parts.slice(1).join(' ').trim();

    let projectPath = target;
    let isGitHub = false;

    // If it's a GitHub link, automatically clone it into the cloud workspace!
    if (target.startsWith('http://') || target.startsWith('https://')) {
      isGitHub = true;
      projectPath = path.join(CLOUD_WORKSPACE_DIR, name);

      ctx.reply(`â³ *Cloning repository from GitHub...*\nðŸ”— \`${target}\`\nðŸ“ Setting up cloud workspace...`, { parse_mode: 'Markdown' });

      try {
        if (fs.existsSync(projectPath)) {
          // If already cloned, just pull latest
          await simpleGit(projectPath).pull();
        } else {
          // Clone fresh repository
          await simpleGit().clone(target, projectPath);
        }
      } catch (err) {
        return ctx.reply(`âš ï¸ Failed to clone repository from GitHub:\n${err.message}`);
      }
    } else {
      // Local folder check
      if (!fs.existsSync(projectPath)) {
        return ctx.reply(`âš ï¸ Local folder does not exist:\n\`${projectPath}\``, { parse_mode: 'Markdown' });
      }
    }

    db.addProject({
      id: name.toLowerCase().replace(/\s+/g, '-'),
      name: name,
      path: projectPath,
      git_url: isGitHub ? target : null,
      tech_stack: 'auto'
    });

    ctx.reply(`âœ… *Project Connected!* ðŸŽ‰\n\nðŸ“Œ *Name:* \`${name}\`\nðŸ“ *Workspace:* \`${projectPath}\`${isGitHub ? '\nðŸ™ *Source:* GitHub Repository' : ''}\n\nYou can now send tasks using:\n\`/task ${name} your instruction\``, { parse_mode: 'Markdown' });
  });

  bot.command('start', async (ctx) => {
    const projects = db.getProjects();
    let msg = `ðŸ‘‹ Welcome to your *Personal AI Developer*!\n\n`;
    if (projects.length === 0) {
      msg += `ðŸ“ No projects connected yet.\nUse \`/addproject <name> <path_or_github_url>\` to connect.`;
    } else {
      msg += `ðŸ“ *Connected Projects:*\n`;
      projects.forEach((p, idx) => {
        msg += `${idx + 1}. \`${p.name}\` (${p.path})\n`;
      });
      msg += `\nSend: \`/task <project_name> <instruction>\` to start developing!`;
    }
    ctx.replyWithMarkdown(msg);
  });

  bot.command('projects', async (ctx) => {
    const projects = db.getProjects();
    if (projects.length === 0) return ctx.reply('No projects connected yet.');
    const buttons = projects.map(p => [Markup.button.callback(`ðŸ“‚ ${p.name}`, `select_${p.id}`)]);
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

    if (!project) return ctx.reply(`âŒ Project "${projectName}" not found. Use /projects to list all.`);

    ctx.reply(`âš¡ Analyzing task for \`${project.name}\`...\nðŸ“ "${prompt}"`, { parse_mode: 'Markdown' });

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

      ctx.reply(`ðŸ“‹ AI Developer Plan:\n\n${plan.slice(0, 3000)}`, Markup.inlineKeyboard([
        [Markup.button.callback('âš¡ Execute & Write Code Now', `exec_${project.id}`)],
        [Markup.button.callback('âŒ Discard', 'cancel')]
      ]));
    } catch (err) {
      ctx.reply(`âš ï¸ Error: ${err.message}`);
    }
  });

  bot.on('callback_query', async (ctx) => {
    const action = ctx.callbackQuery.data;
    await ctx.answerCbQuery();

    if (action === 'cancel') return ctx.reply('âŒ Task cancelled.');

    if (action.startsWith('exec_')) {
      const projectId = action.replace('exec_', '');
      const taskData = pendingPlans[projectId];
      if (!taskData) return ctx.reply('âš ï¸ No pending task found.');

      const { project, prompt, plan } = taskData;
      ctx.reply(`ðŸš€ Reading existing files and applying changes safely to \`${project.name}\`...`, { parse_mode: 'Markdown' });

      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash-lite' });
        const tools = createAgentTools(project.path);

        // Find files
        const rootFiles = await tools.listFiles({});
        let targetFile = 'index.html';
        
        // If subfolder exists (like sivaportfolio-main)
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
3. Add the requested feature (e.g. WhatsApp button, contact feature) seamlessly with appropriate CSS/JS.
4. Return ONLY valid JSON:
{
  "filepath": "${targetFile}",
  "content": "THE ENTIRE UPDATED FILE INCLUDING THE NEW FEATURE",
  "summary": "Brief explanation of what was added"
}`;

        ctx.reply('âœï¸ Writing updated code to files...');
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

          // If it was a GitHub project, commit and push!
          if (project.git_url) {
            ctx.reply('ðŸ“¤ Pushing changes to GitHub so Netlify can redeploy live...');
            try {
              const git = simpleGit(project.path);
              await git.add('.');
              await git.commit('Update from AI Developer: ' + (change.summary || 'Feature update'));
              await git.push();
              ctx.reply('ðŸš€ Successfully pushed to GitHub! Netlify is auto-deploying your live site.');
            } catch (gitErr) {
              ctx.reply(`â„¹ï¸ Code updated locally in workspace. (Git push note: ${gitErr.message})`);
            }
          }

          ctx.reply(`ðŸŽ‰ Changes successfully applied!\n\nðŸ“„ File: ${change.filepath}\nðŸ“ Summary: ${change.summary || 'Updated'}\n\nðŸŒ Netlify Live URL:\nhttps://stately-twilight-6dba65.netlify.app/`);
        } else {
          ctx.reply('âš ï¸ Could not parse code output.');
        }

        delete pendingPlans[projectId];
      } catch (err) {
        ctx.reply(`âš ï¸ Execution error: ${err.message}`);
      }
    }
  });

  if (!process.env.RENDER) {
    bot.launch().catch(e => console.error(e));
  }
  return bot;
}

module.exports = { setupTelegramBot };
