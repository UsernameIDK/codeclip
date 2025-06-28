#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import clipboardy from 'clipboardy';
import ignore from 'ignore';

const MAX_SIZE = 5 * 1024 * 1024; // 5MB
let currentSize = 0;
let limitReached = false;

// Create synchronous readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function questionSync(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

// Check if directory contains a git repo
function isGitRepo(dir) {
  let current = dir;
  while (current !== path.parse(current).root) {
    const gitPath = path.join(current, '.git');
    try {
      if (fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory()) {
        return current; // Return git root
      }
    } catch {}
    current = path.dirname(current);
  }
  return null;
}

// Combined binary detection
function isBinaryFile(buffer, filePath) {
  // 1. Extension check (fast path)
  const binaryExts = new Set([
    '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pyc', '.o', '.obj',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.psd', '.tiff',
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.mp4', '.avi', '.mov', '.mkv', '.flv',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz',
    '.db', '.sqlite', '.mdb'
  ]);
  
  const ext = path.extname(filePath).toLowerCase();
  if (binaryExts.has(ext)) return true;

  // 2. Null byte check
  if (buffer.includes(0)) return true;

  // 3. Control character check
  let nonPrintable = 0;
  const sampleSize = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) nonPrintable++;
  }
  return nonPrintable / sampleSize > 0.3;
}

// Load all .gitignore files from root down to current directory
function loadGitIgnoreRules(rootDir) {
  const ig = ignore();
  let current = process.cwd();
  
  while (current && current.startsWith(rootDir)) {
    const gitignorePath = path.join(current, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const rules = fs.readFileSync(gitignorePath, 'utf8');
        ig.add(rules);
      } catch {}
    }
    
    // Stop at git root if found
    if (current === rootDir) break;
    current = path.dirname(current);
  }
  
  return ig;
}

// Main processing function
function processDirectory(dirPath, ig) {
  let output = '';

  let files;
  try {
    files = fs.readdirSync(dirPath);
  } catch {
    return ''; // Ignore unreadable directories
  }

  for (const file of files) {
    if (limitReached) return output;

    const filePath = path.join(dirPath, file);
    const relativePath = path.relative(process.cwd(), filePath);

    // Skip dotfiles (except .gitignore itself)
    if (file.startsWith('.') && file !== '.gitignore') continue;

    let stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch {
      continue;
    }

    // Skip symlinks
    if (stats.isSymbolicLink()) continue;

    // Check .gitignore rules
    if (ig.ignores(relativePath)) {
      continue;
    }

    if (stats.isDirectory()) {
      const folderHeader = `\n--- Folder: ${relativePath} ---\n`;
      if (currentSize + folderHeader.length > MAX_SIZE) {
        limitReached = true;
        return output;
      }
      
      const folderOutput = processDirectory(filePath, ig);
      if (folderOutput) {
        output += folderHeader + folderOutput;
        currentSize += Buffer.byteLength(folderHeader, 'utf8');
      }
    } else if (stats.isFile()) {
      const fileHeader = `\n--- File: ${relativePath} ---\n`;
      const headerSize = Buffer.byteLength(fileHeader, 'utf8');
      
      // Skip if header alone exceeds limit
      if (currentSize + headerSize > MAX_SIZE) {
        limitReached = true;
        return output;
      }

      let buffer;
      try {
        buffer = fs.readFileSync(filePath);
      } catch {
        continue; // Skip unreadable files
      }

      // Handle binary files
      if (isBinaryFile(buffer, filePath)) {
        const note = `${fileHeader}[BINARY FILE SKIPPED]\n`;
        const noteSize = Buffer.byteLength(note, 'utf8');
        if (currentSize + noteSize > MAX_SIZE) {
          limitReached = true;
          return output;
        }
        output += note;
        currentSize += noteSize;
        continue;
      }

      // Process text file
      const content = buffer.toString('utf8');
      const contentSize = Buffer.byteLength(content, 'utf8');
      const totalSize = headerSize + contentSize;

      if (currentSize + totalSize > MAX_SIZE) {
        limitReached = true;
        return output;
      }

      output += fileHeader + content;
      currentSize += totalSize;
    }
  }

  return output;
}

// Main execution
async function main() {
  const rootDir = process.cwd();
  const gitRoot = isGitRepo(rootDir);
  
  // Check for git repository
  if (!gitRoot) {
    const answer = await questionSync('⚠️  No git repository found in this directory. Continue? (y/n) ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Operation cancelled.');
      rl.close();
      return;
    }
  }

  // Load .gitignore rules from the git root or current directory
  const ig = loadGitIgnoreRules(gitRoot || rootDir);

  let finalOutput = `--- Root Directory: ${path.basename(rootDir)} ---\n`;
  currentSize += Buffer.byteLength(finalOutput, 'utf8');
  
  finalOutput += processDirectory(rootDir, ig);

  try {
    await clipboardy.write(finalOutput);
    if (limitReached) {
      console.log('⚠️  Output truncated at 5MB limit. Partial codebase copied to clipboard.');
    } else {
      console.log('✅  Codebase context copied to clipboard!');
    }
  } catch (err) {
    console.error('❌  Failed to write to clipboard:', err.message);
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('❌  Unexpected error:', err);
  rl.close();
  process.exit(1);
});