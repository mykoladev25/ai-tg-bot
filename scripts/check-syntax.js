const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['.git', '.github', '.idea', '.codex', 'node_modules']);
const SKIP_FILES = new Set(['package-lock.json']);

function collectJsFiles(dirPath, files = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      collectJsFiles(path.join(dirPath, entry.name), files);
      continue;
    }

    if (!entry.name.endsWith('.js') || SKIP_FILES.has(entry.name)) {
      continue;
    }

    files.push(path.join(dirPath, entry.name));
  }

  return files;
}

const jsFiles = collectJsFiles(ROOT_DIR).sort();
const failures = [];

for (const filePath of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({
      filePath,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n')
    });
  }
}

if (failures.length > 0) {
  console.error(`Syntax check failed for ${failures.length} file(s).`);
  for (const failure of failures) {
    console.error(`\n--- ${path.relative(ROOT_DIR, failure.filePath)} ---\n${failure.output}`);
  }
  process.exit(1);
}

console.log(`Syntax check passed for ${jsFiles.length} JavaScript file(s).`);
