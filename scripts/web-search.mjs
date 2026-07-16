import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_OUTPUT_DIR = path.join(__dirname, 'temp_output');
const PROFILE_DIR = path.join(__dirname, 'browser-profile');
const MAX_OUTPUT_FILES = 25;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ENGINES = {
  google: {
    id: 'google',
    url: 'https://www.google.com/search?q=',
    titleSelector: 'h3',
    botIndicators: ['captcha', 'robot', 'verify you are human', 'cloudflare'],
  },
  duckduckgo: {
    id: 'duckduckgo',
    url: 'https://duckduckgo.com/?q=',
    titleSelector: 'a[data-testid="result-title-a"]',
    botIndicators: ['captcha', 'robot', 'verify you are human', 'cloudflare'],
  },
};

const ENGINE_PRIORITY = ['duckduckgo'];

function getBravePath() {
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  } else if (process.platform === 'darwin') {
    return '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  } else {
    return '/usr/bin/brave-browser';
  }
}

function unwrapUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.hostname.includes('google.com') && url.pathname === '/url') {
      const q = url.searchParams.get('q');
      if (q) return q;
    }
    if (url.hostname.includes('duckduckgo.com') && url.pathname.includes('/l/')) {
      const uddg = url.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    if (url.hostname.includes('bing.com')) {
      const u = url.searchParams.get('u');
      if (u) return u;
    }
  } catch (e) {
    // Ignore URL parsing errors
  }
  return urlString;
}

function slugifyUrl(urlString, maxLen = 60) {
  try {
    const parsed = new URL(urlString);
    const raw = (parsed.hostname + parsed.pathname).replace(/^\//, '');
    const slug = raw.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug.substring(0, maxLen);
  } catch (e) {
    return 'scraped_page';
  }
}

function makeOutputFilename(urlString) {
  if (!fs.existsSync(TEMP_OUTPUT_DIR)) {
    fs.mkdirSync(TEMP_OUTPUT_DIR, { recursive: true });
  }
  const slug = slugifyUrl(urlString);
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(TEMP_OUTPUT_DIR, `${slug}_${rand}.md`);
}

function cleanupOldFiles() {
  if (!fs.existsSync(TEMP_OUTPUT_DIR)) return;
  const files = fs.readdirSync(TEMP_OUTPUT_DIR)
    .filter(file => file.endsWith('.md'))
    .map(file => {
      const filePath = path.join(TEMP_OUTPUT_DIR, file);
      const stat = fs.statSync(filePath);
      return { path: filePath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);

  const excess = files.length - MAX_OUTPUT_FILES;
  if (excess > 0) {
    for (let i = 0; i < excess; i++) {
      fs.unlinkSync(files[i].path);
      console.error(`[cleanup] Deleted old file: ${path.basename(files[i].path)}`);
    }
  }
}

async function extractResultsFromPage(page, maxResults, engineId) {
  const results = [];
  const seenUrls = new Set();

  if (engineId === 'duckduckgo') {
    const resultLinks = await page.$$('a[data-testid="result-title-a"]');
    for (const link of resultLinks) {
      try {
        const href = await link.getAttribute('href') || '';
        const url = unwrapUrl(href);
        if (!url.startsWith('http') || seenUrls.has(url)) continue;

        const title = (await link.innerText()).trim();
        if (title.length < 10) continue;

        let snippet = '';
        try {
          snippet = await link.evaluate(
            el => el.closest('article')?.querySelector('[data-result=snippet]')?.textContent || ''
          );
          snippet = snippet.trim();
        } catch (e) {}

        seenUrls.add(url);
        results.push({ title, url, snippet });
        if (results.length >= maxResults) break;
      } catch (e) {}
    }
  } else {
    const resultLinks = await page.$$('a:has(h3)');
    for (const link of resultLinks) {
      try {
        const href = await link.getAttribute('href') || '';
        const url = unwrapUrl(href);
        if (!url.startsWith('http') || seenUrls.has(url)) continue;

        if (['google.com', 'duckduckgo.com', 'javascript:', 'accounts.google'].some(x => url.includes(x))) {
          continue;
        }

        const h3 = await link.$('h3');
        const title = h3 ? (await h3.innerText()).trim() : '';
        if (title.length < 10) continue;

        let snippet = '';
        try {
          snippet = await link.evaluate(
            el => el.closest('.tF2Cxc, .g')?.querySelector('.VwiC3b')?.textContent || ''
          );
          snippet = snippet.trim();
        } catch (e) {}

        seenUrls.add(url);
        results.push({ title, url, snippet });
        if (results.length >= maxResults) break;
      } catch (e) {}
    }
  }

  return results;
}

async function solveCaptchaHeaded(url, engine, maxResults) {
  console.error('CAPTCHA detected! Opening browser for manual resolution...');
  console.error('Please solve the CAPTCHA. The script will continue once results are detected.');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: getBravePath(),
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ],
  });

  let page;
  if (context.pages().length > 0) {
    page = context.pages()[0];
    const extra = context.pages().slice(1);
    for (const p of extra) await p.close();
  } else {
    page = await context.newPage();
  }

  await page.goto(url);

  let results = null;
  try {
    await page.waitForSelector(engine.titleSelector, { timeout: 3600000 });
    await page.waitForLoadState('networkidle');
    results = await extractResultsFromPage(page, maxResults, engine.id);
  } catch (e) {
    console.error('CAPTCHA resolution timed out.');
  } finally {
    await context.close();
  }

  return results;
}

async function runSearch(query, maxResults = 8) {
  if (!query || !query.trim()) {
    throw new Error('Search query must be a non-empty string.');
  }

  for (const engineId of ENGINE_PRIORITY) {
    const engine = ENGINES[engineId];
    const searchUrl = engine.url + encodeURIComponent(query);
    console.error(`Query: ${query}\nTrying ${engineId}...`);

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      executablePath: getBravePath(),
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      ignoreHTTPSErrors: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-infobars',
      ],
    });

    try {
      let page;
      if (context.pages().length > 0) {
        page = context.pages()[0];
        const extra = context.pages().slice(1);
        for (const p of extra) await p.close();
      } else {
        page = await context.newPage();
      }

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const content = (await page.content()).toLowerCase();
      if (engine.botIndicators.some(ind => content.includes(ind))) {
        console.error(`Bot detection triggered on ${engineId}.`);
        await context.close();
        const results = await solveCaptchaHeaded(searchUrl, engine, maxResults);
        if (results) return results;
        continue;
      }

      try {
        await page.waitForSelector(engine.titleSelector, { timeout: 15000 });
      } catch (e) {
        console.error(`Results selector not found on ${engineId}`);
        continue;
      }

      const results = await extractResultsFromPage(page, maxResults, engineId);
      if (results && results.length > 0) {
        return results;
      }
      console.error(`No results extracted from ${engineId}`);
    } catch (e) {
      console.error(`Error using ${engineId}: ${e.message}`);
    } finally {
      await context.close();
    }
  }

  throw new Error('All search engines failed to return results.');
}

async function scrapePage(url) {
  const parsed = new URL(url);
  if (!parsed.protocol || !parsed.hostname) {
    throw new Error(`Invalid URL: ${url}`);
  }

  const SKIP_NETWORKIDLE = new Set([
    'x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'tiktok.com', 'threads.net'
  ]);
  const host = parsed.hostname.replace(/^www\./, '');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    executablePath: getBravePath(),
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ],
  });

  let markdown = '';
  try {
    let page;
    if (context.pages().length > 0) {
      page = context.pages()[0];
      const extra = context.pages().slice(1);
      for (const p of extra) await p.close();
    } else {
      page = await context.newPage();
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (SKIP_NETWORKIDLE.has(host)) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch (e) {}
    }

    markdown = await page.evaluate(() => {
      const noisy = ['script', 'style', 'iframe', 'noscript', 'svg', 'head', 'nav', 'footer', 'header', 'aside', 'form', 'button'];
      noisy.forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });

      function cleanText(text) {
        return text.replace(/\s+/g, ' ').trim();
      }

      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.nodeValue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }

        const tagName = node.tagName.toUpperCase();
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return '';
        }

        let childrenText = '';
        for (const child of node.childNodes) {
          childrenText += walk(child);
        }

        switch (tagName) {
          case 'H1': return `\n\n# ${cleanText(childrenText)}\n\n`;
          case 'H2': return `\n\n## ${cleanText(childrenText)}\n\n`;
          case 'H3': return `\n\n### ${cleanText(childrenText)}\n\n`;
          case 'H4': return `\n\n#### ${cleanText(childrenText)}\n\n`;
          case 'H5': return `\n\n##### ${cleanText(childrenText)}\n\n`;
          case 'H6': return `\n\n###### ${cleanText(childrenText)}\n\n`;
          case 'P':
          case 'DIV':
            const pTxt = cleanText(childrenText);
            return pTxt ? `\n\n${pTxt}\n\n` : '';
          case 'BR': return '\n';
          case 'LI': return `\n* ${childrenText.trim()}`;
          case 'UL':
          case 'OL': return `\n${childrenText}\n`;
          case 'A':
            const href = node.getAttribute('href');
            const aTxt = cleanText(childrenText);
            if (href && aTxt && !href.startsWith('javascript:')) {
              try {
                const absoluteUrl = new URL(href, document.baseURI).href;
                return ` [${aTxt}](${absoluteUrl}) `;
              } catch (e) {
                return ` [${aTxt}](${href}) `;
              }
            }
            return aTxt ? ` ${aTxt} ` : '';
          case 'STRONG':
          case 'B':
            const bTxt = cleanText(childrenText);
            return bTxt ? ` **${bTxt}** ` : '';
          case 'EM':
          case 'I':
            const iTxt = cleanText(childrenText);
            return iTxt ? ` *${iTxt}* ` : '';
          case 'CODE': return ` \`${childrenText.trim()}\` `;
          case 'PRE': return `\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n`;
          case 'TABLE': return `\n\n${childrenText}\n\n`;
          case 'TR': return `\n| ${childrenText}`;
          case 'TD':
          case 'TH': return `${cleanText(childrenText)} |`;
          default: return childrenText;
        }
      }

      let md = walk(document.body);
      md = md.replace(/\n{3,}/g, '\n\n');
      md = md.replace(/[ \t]+/g, ' ');
      md = md.split('\n').map(line => line.trim()).join('\n');
      md = md.replace(/\n{3,}/g, '\n\n');
      return md.trim();
    });

  } finally {
    await context.close();
  }

  if (!markdown || !markdown.trim()) {
    throw new Error('Scraped content is empty -- page may require auth or blocked the scraper.');
  }

  return markdown;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
web-search.mjs — Playwright-powered search & scrape tool

Usage:
  node web-search.mjs <query>               # search
  node web-search.mjs --scrape <url>        # scrape (saves to ./temp_output/, prints file path)
`);
    process.exit(1);
  }

  const startTime = Date.now();

  if (args.includes('--scrape')) {
    const idx = args.indexOf('--scrape');
    const targetUrl = args[idx + 1];

    console.error(`Scraping: ${targetUrl}`);

    let fileContent = '';
    try {
      const markdown = await scrapePage(targetUrl);
      console.error(`[scrape] Content length: ${markdown.length} chars`);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      fileContent = `Source URL: ${targetUrl}\n\n${markdown}\n\nTotal Time: ${duration}s\n`;
    } catch (e) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      fileContent = `Source URL: ${targetUrl}\n\nERROR: ${e.message}\n\n${e.stack}\nTotal Time: ${duration}s\n`;
    }

    cleanupOldFiles();
    const outputPath = makeOutputFilename(targetUrl);
    fs.writeFileSync(outputPath, fileContent, 'utf-8');

    process.stdout.write(`Output saved to: ${path.resolve(outputPath)}\n`);

  } else {
    const query = args.join(' ');
    try {
      const results = await runSearch(query);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      const dateOptions = { year: 'numeric', month: 'long', day: 'numeric' };
      const dateStr = new Date().toLocaleDateString('en-US', dateOptions);

      console.log(`Current date: ${dateStr}\n`);
      console.log(JSON.stringify(results, null, 2));
      console.log(`\nTotal Time: ${duration}s`);
    } catch (e) {
      console.error(`Search failed: ${e.message}`);
      process.exit(1);
    }
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
