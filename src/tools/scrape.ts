import { getBrowserContext } from '../browser.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { logActivity, saveOutput } from '../utils/logger.js';

export async function scrapePage(url: string): Promise<string> {
    const context = await getBrowserContext(false);
    const page = await context.newPage();

    try {
        logActivity('scrape', `Scraping URL: ${url}`);

        // Anti-bot evasions for this page context
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // Wait a tiny bit for JS-rendered content if needed, but not too long
        await page.waitForTimeout(3000);

        // Get the full raw HTML from Playwright
        const html = await page.content();

        let finalMarkdown = '';

        // If content is very short or looks like an anti-bot challenge
        if (html.includes('cf-browser-verification') || html.includes('cf-turnstile') || html.length < 500) {
            logActivity('scrape-warning', "Possible Cloudflare or short content. Grabbing innerText as fallback.");
            const innerText = await page.evaluate(() => document.body.innerText);
            finalMarkdown = `# Scraped Text (Fallback)\n\n${innerText}`;
        } else {
            // Parse HTML using JSDOM in Node (much safer than injecting scripts into the page)
            const dom = new JSDOM(html, { url });

            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (!article || !article.content) {
                logActivity('scrape-warning', "Readability failed. Falling back to innerText.");
                const innerText = await page.evaluate(() => document.body.innerText);
                finalMarkdown = `# Scraped Text (Fallback)\n\n${innerText}`;
            } else {
                // Convert the Readability HTML to Markdown using Turndown
                const turndownService = new TurndownService({
                    headingStyle: 'atx',
                    codeBlockStyle: 'fenced'
                });
                const markdownContent = turndownService.turndown(article.content);

                const title = article.title || 'Scraped Content';
                finalMarkdown = `# ${title}\n\n**Source:** ${url}\n\n${markdownContent}`;
            }
        }

        logActivity('scrape-success', `Successfully extracted content length: ${finalMarkdown.length}`);

        // Save to file for easy user viewing
        saveOutput('scrape', finalMarkdown);

        return finalMarkdown;
    } catch (error) {
        logActivity('scrape-error', `Scraping failed: ${(error as Error).message}`);
        return `Error scraping ${url}: ${(error as Error).message}`;
    } finally {
        await page.close();
    }
}
