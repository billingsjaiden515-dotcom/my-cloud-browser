import { execSync } from 'child_process';
import { existsSync } from 'fs';

export interface BrowserInfo {
  name: string;
  executablePath: string;
  available: boolean;
  displayName: string;
}

/**
 * Browsers built on Chromium/Blink, which speak CDP and accept Chromium's
 * command-line flags. Everything NOT in this set is treated as a WebDriver
 * BiDi browser: no CDP flags, no CDP network events, its own window class.
 *
 * This is deliberately a property of the BROWSER, not "is it Chromium
 * specifically". Brave, Vivaldi and Opera GX are all Chromium-based, so they
 * take the identical launch path and get the identical diagnostics and
 * geometry measurement as Chromium -- only the binary differs. Gating those
 * three behaviours on `=== 'chromium'` instead would have silently given
 * every future Chromium-based browser a BiDi-shaped, CDP-less session.
 */
export const CHROMIUM_FAMILY = new Set(['chromium', 'brave', 'vivaldi', 'opera', 'opera_gx']);

export function isChromiumFamily(browserType: string): boolean {
  return CHROMIUM_FAMILY.has(browserType);
}

const BROWSER_PATHS: Record<string, string[]> = {
  chromium: [
    '/nix/store',  // checked dynamically below
    // macOS paths
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux paths
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ],
  firefox: [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/usr/bin/firefox',
    '/usr/bin/firefox-esr',
    '/snap/bin/firefox',
  ],
  brave: [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/opt/brave.com/brave/brave',
  ],
vivaldi: [
    '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    '/usr/bin/vivaldi-stable',
    '/usr/bin/vivaldi',
    '/opt/vivaldi/vivaldi',
  ],
};

function findInNixStore(binary: string): string | null {
  try {
    const result = execSync(`find /nix/store -maxdepth 3 -name "${binary}" -type f 2>/dev/null | head -1`, {
      timeout: 5000,
      encoding: 'utf8',
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function findExecutable(name: string): string | null {
  try {
    const result = execSync(`which ${name} 2>/dev/null || command -v ${name} 2>/dev/null`, {
      timeout: 3000,
      encoding: 'utf8',
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

let chromiumPathCache: string | null = null;

export function getChromiumPath(): string {
  if (chromiumPathCache) return chromiumPathCache;

  // Allow explicit override via env (e.g. Render/Docker installs Chromium elsewhere)
  const envPath = process.env.CHROMIUM_PATH;
  if (envPath && existsSync(envPath)) {
    chromiumPathCache = envPath;
    return envPath;
  }

  // Try 'which' first
  const which = findExecutable('chromium') || findExecutable('chromium-browser') || findExecutable('google-chrome');
  if (which && existsSync(which)) {
    chromiumPathCache = which;
    return which;
  }

  // Try known static paths
  for (const p of BROWSER_PATHS.chromium.slice(1)) {
    if (existsSync(p)) {
      chromiumPathCache = p;
      return p;
    }
  }

  // Search nix store
  const nixPath = findInNixStore('chromium') || findInNixStore('chrome');
  if (nixPath && existsSync(nixPath)) {
    chromiumPathCache = nixPath;
    return nixPath;
  }

  throw new Error('Chromium not found. Please install it via system packages.');
}

export function getBrowserInfo(): BrowserInfo[] {
  const browsers: BrowserInfo[] = [];

  // Chromium (always listed, required to work)
  let chromiumPath: string | null = null;
  try {
    chromiumPath = getChromiumPath();
  } catch {
    chromiumPath = null;
  }
  browsers.push({
    name: 'chromium',
    displayName: 'Chromium',
    executablePath: chromiumPath || '',
    available: !!chromiumPath,
  });

  // Firefox
  const firefoxPath = findExecutable('firefox') || findExecutable('firefox-esr') ||
    BROWSER_PATHS.firefox.find(p => existsSync(p)) || null;
  browsers.push({
    name: 'firefox',
    displayName: 'Mozilla Firefox',
    executablePath: firefoxPath || '',
    available: !!firefoxPath,
  });

  // Brave
  const bravePath = findExecutable('brave-browser') || findExecutable('brave') ||
    BROWSER_PATHS.brave.find(p => existsSync(p)) || null;
  browsers.push({
    name: 'brave',
    displayName: 'Brave',
    executablePath: bravePath || '',
    available: !!bravePath,
  });

  // Vivaldi. Debian/Ubuntu package installs the binary as `vivaldi-stable`
  // (hence both names below); macOS ships Vivaldi.app/Contents/MacOS/Vivaldi.
  const vivaldiPath = findExecutable('vivaldi-stable') || findExecutable('vivaldi') ||
    BROWSER_PATHS.vivaldi.find(p => existsSync(p)) || null;
  browsers.push({
    name: 'vivaldi',
    displayName: 'Vivaldi',
    executablePath: vivaldiPath || '',
    available: !!vivaldiPath,
  });

  return browsers;
}
