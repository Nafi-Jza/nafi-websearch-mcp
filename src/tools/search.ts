import { getBrowserContext } from '../browser.js';
import { logActivity } from '../utils/logger.js';

export async function runSearch(query: string): Promise<string> {
    logActivity('search', `Starting search query: "${query}"`);

    // IMPORTANT: We MUST use headed mode (true) here.
    // Headless Chromium ignores the UI-configured custom DNS over HTTPS settings.
    // By running headed, we inherit the Secure DNS setting which bypasses Internet Positif block.
    const context = await getBrowserContext(true);
    const page = await context.newPage();

    try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        logActivity('search', `Navigating to: ${searchUrl}`);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Check if we got intercepted by Internet Positif
        const html = await page.content();
        if (html.includes('Internet Positif') || html.includes('trustpositif')) {
             logActivity('search-error', `Blocked by Internet Positif`);
             return JSON.stringify({ error: "Search blocked by Internet Positif even with profile. The secure DNS setting might not be applying." });
        }

        // Wait for results
        try {
            await page.waitForSelector('.result', { timeout: 10000 });
        } catch (e) {
            logActivity('search-result', `No results found.`);
            return JSON.stringify([]); // No results found
        }

        // Extract DuckDuckGo results
        const results = await page.$$eval('.result', (elements: any[]) => {
            return elements.map(el => {
                const titleLinkEl = el.querySelector('.result__title a');
                const snippetEl = el.querySelector('.result__snippet');

                if (titleLinkEl) {
                    // DuckDuckGo URL is sometimes a redirect (//duckduckgo.com/l/?uddg=...),
                    // we want to extract the actual destination if possible.
                    let url = titleLinkEl.getAttribute('href') || '';
                    if (url.includes('uddg=')) {
                        try {
                            const urlParams = new URLSearchParams(url.split('?')[1]);
                            const actualUrl = urlParams.get('uddg');
                            if (actualUrl) url = decodeURIComponent(actualUrl);
                        } catch(e) {}
                    }

                    return {
                        title: titleLinkEl.textContent?.trim() || '',
                        url: url,
                        snippet: snippetEl ? snippetEl.textContent?.trim() : ''
                    };
                }
                return null;
            }).filter(Boolean);
        });

        logActivity('search-result', `Found ${results.length} results.`);
        return JSON.stringify(results, null, 2);
    } catch (error) {
        logActivity('search-error', `Search failed: ${(error as Error).message}`);
        return JSON.stringify({ error: `Search failed: ${(error as Error).message}` });
    } finally {
        await page.close();
    }
}
