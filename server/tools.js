const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function createAgentTools(worktreePath) {
  return {
    listFiles: async ({ subpath = '.' }) => {
      const fullPath = path.resolve(worktreePath, subpath);
      if (!fullPath.startsWith(path.resolve(worktreePath))) {
        throw new Error('Access outside workspace denied');
      }
      return fs.readdirSync(fullPath, { withFileTypes: true }).map(dirent => ({
        name: dirent.name,
        isDirectory: dirent.isDirectory()
      }));
    },

    readFile: async ({ filepath }) => {
      const fullPath = path.resolve(worktreePath, filepath);
      if (!fullPath.startsWith(path.resolve(worktreePath))) {
        throw new Error('Access outside workspace denied');
      }
      return fs.readFileSync(fullPath, 'utf8');
    },

    writeFile: async ({ filepath, content }) => {
      const fullPath = path.resolve(worktreePath, filepath);
      if (!fullPath.startsWith(path.resolve(worktreePath))) {
        throw new Error('Access outside workspace denied');
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      return `Successfully wrote to ${filepath}`;
    },

    runCommand: async ({ command }) => {
      // Basic safety: block dangerous destructive commands
      const lower = command.toLowerCase();
      if (lower.includes('rm -rf /') || lower.includes('drop database') || lower.includes('format')) {
        return 'Execution blocked: Command flagged as potentially destructive';
      }

      return new Promise((resolve) => {
        exec(command, { cwd: worktreePath, timeout: 60000 }, (error, stdout, stderr) => {
          let output = stdout || '';
          if (stderr) output += `\n[STDERR]: ${stderr}`;
          if (error) output += `\n[ERROR]: ${error.message}`;
          resolve(output.slice(0, 4000)); // Limit output length
        });
      });
    }
  };
}

module.exports = { createAgentTools };

