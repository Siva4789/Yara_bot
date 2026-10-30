Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\Admin\.gemini\antigravity\scratch\personal-ai-dev"
WshShell.Run "node server/index.js", 0, False

