const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const NOTES_DIR = path.join(__dirname, "..", "notes");

function isGitRepo() {
  return fs.existsSync(path.join(NOTES_DIR, ".git"));
}

function gitSync(commitMessage) {
  if (!isGitRepo()) {
    console.error("[KB] Git-Sync übersprungen: notes/ ist kein Git-Repo. Setup: cd notes && git init && git remote add origin <repo-url>");
    return;
  }

  const cmd = `cd "${NOTES_DIR}" && git add -A && git diff --cached --quiet || (git commit -m "${commitMessage.replace(/"/g, '\\"')}" && git push 2>&1)`;

  const child = exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      // Timeout oder Fehler — nur loggen, kein Crash
      console.error("[KB] Git-Sync Fehler:", err.message);
      return;
    }
    if (stdout && stdout.trim()) {
      console.log("[KB] Git-Sync:", stdout.trim().split("\n").pop());
    }
  });

  // Fire-and-forget: keine Promises, kein await
  child.unref();
}

module.exports = { gitSync, isGitRepo };
