import { getBrowserContext } from '../browser.js';

export async function runSearch(query: string): Promise<string> {
    const context = await getBrowserContext(false);
    const page = await context.newPage();

    try {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        console.log(`Navigating to Google search: ${searchUrl}`);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Check for Google's consent or captcha pages
        if (page.url().includes('consent.google.com') || page.url().includes('sorry/index')) {
             return JSON.stringify({ error: "Google is blocking this request with a CAPTCHA or consent screen. You may need to run the open_browser tool to solve it." });
        }

        // Wait for results
        try {
            await page.waitForSelector('div.g', { timeout: 10000 });
        } catch (e) {
            return JSON.stringify([]); // No results found
        }

        // Extract results
        const results = await page.$$eval('div.g', (elements: any[]) => {
            return elements.map(el => {
                const titleEl = el.querySelector('h3');
                const linkEl = el.querySelector('a');
                // The snippet is tricky. We look for divs containing text that aren't the title.
                // A common class is .VwiC3b or .IsZvec.
                const snippetEl = el.querySelector('.VwiC3b, .IsZvec, .lyLwlc');

                let snippetText = snippetEl ? snippetEl.textContent?.trim() : '';

                if (titleEl && linkEl) {
                    return {
                        title: titleEl.textContent?.trim() || '',
                        url: linkEl.getAttribute('href') || '',
                        snippet: snippetText || ''
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
