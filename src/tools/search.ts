import { getBrowserContext } from '../browser.js';

export async function runSearch(query: string): Promise<string> {
    const context = await getBrowserContext(false);
    const page = await context.newPage();

    try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        console.log(`Navigating to DuckDuckGo search: ${searchUrl}`);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const html = await page.content();
        if (html.includes('Internet Positif') || html.includes('trustpositif')) {
             return JSON.stringify({ error: "Search blocked by Internet Positif. Please check your DNS or proxy settings in the open_browser profile." });
        }

        if (page.url().includes('duckduckgo.com/lite/') || page.url().includes('duckduckgo.com/x.js')) {
             return JSON.stringify({ error: "DuckDuckGo is currently blocking this request or requiring a CAPTCHA. You may need to run the open_browser tool to solve it." });
        }

        try {
            await page.waitForSelector('.result', { timeout: 10000 });
        } catch (e) {
            const noResults = await page.$('.no-results');
            if (noResults) {
                return JSON.stringify([]);
            }
            throw new Error("Failed to find results container. DDG might have changed layout or blocked the request.");
        }

        const results = await page.$$eval('.result', (elements: any[]) => {
            return elements.map(el => {
                const titleLinkEl = el.querySelector('.result__title a');
                const snippetEl = el.querySelector('.result__snippet');

                if (titleLinkEl) {
                    return {
                        title: titleLinkEl.textContent?.trim() || '',
                        url: titleLinkEl.getAttribute('href') || '',
                        snippet: snippetEl ? snippetEl.textContent?.trim() : ''
                    };
                }
                return null;
            }).filter(Boolean);
        });

        return JSON.stringify(results, null, 2);
    } catch (error) {
        console.error("Search failed:", error);
        return JSON.stringify({ error: `Search failed: ${(error as Error).message}` });
    } finally {
        await page.close();
    }
}
