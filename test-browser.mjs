import { existsSync } from 'fs';

const paths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

for (const p of paths) {
  console.log(`${p}: ${existsSync(p) ? 'EXISTS' : 'not found'}`);
}

// Test if we can spawn Chrome
import { spawn } from 'child_process';
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--version'], { timeout: 5000 });
chrome.stdout.on('data', (d) => console.log('stdout:', d.toString().trim()));
chrome.stderr.on('data', (d) => console.log('stderr:', d.toString().trim()));
chrome.on('error', (e) => console.log('error:', e.message));
chrome.on('close', (code) => console.log('exit code:', code));