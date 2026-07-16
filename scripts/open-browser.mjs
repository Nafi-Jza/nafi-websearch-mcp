import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_DIR = path.join(__dirname, 'browser-profile');
const TARGET_URL = process.argv[2] || 'https://www.google.com';

function getBravePath() {
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  } else if (process.platform === 'darwin') {
    return '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  } else {
    return '/usr/bin/brave-browser';
  }
}

async function main() {
  console.log(`Opening browser -> ${TARGET_URL}`);
  console.log(`Profile dir: ${PROFILE_DIR}`);
  console.log('Close the browser window when done.');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: getBravePath(),
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
      '--disable-extensions',
    ],
  });

  const page = await context.newPage();
  await page.goto(TARGET_URL);

  try {
    await page.waitForEvent('close', { timeout: 3600000 });
  } catch (e) {
    // Ignore timeout
  }

  await context.close();
  console.log('Browser closed.');
}

main().catch(console.error);
