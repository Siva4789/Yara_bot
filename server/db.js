const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'platform_data.json');

// Simple persistent JSON database without C++ build dependencies
function loadData() {
  if (!fs.existsSync(dbPath)) {
    const initial = { projects: [], tasks: [], logs: [] };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (e) {
    return { projects: [], tasks: [], logs: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
}

const db = {
  getProjects: () => loadData().projects,
  addProject: (project) => {
    const data = loadData();
    const existingIndex = data.projects.findIndex(p => p.id === project.id);
    if (existingIndex >= 0) {
      data.projects[existingIndex] = { ...data.projects[existingIndex], ...project };
    } else {
      data.projects.push({ ...project, created_at: new Date().toISOString() });
    }
    saveData(data);
    return project;
  },
  getTasks: () => loadData().tasks,
  addTask: (task) => {
    const data = loadData();
    data.tasks.push({ ...task, created_at: new Date().toISOString() });
    saveData(data);
    return task;
  },
  addLog: (log) => {
    const data = loadData();
    data.logs.push({ ...log, timestamp: new Date().toISOString() });
    saveData(data);
    return log;
  }
};

module.exports = db;
