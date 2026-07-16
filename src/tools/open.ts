import { getBrowserContext } from '../browser.js';
import { logActivity } from '../utils/logger.js';

export async function openBrowser(url?: string): Promise<string> {
    logActivity('open_browser', "Opening headed browser for manual interaction...");

    // Pass 'true' to get a headed context
    const context = await getBrowserContext(true);

    // Try to find an existing empty page or create a new one
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    if (!page) {
         logActivity('open_browser-error', "Could not obtain a page in the headed browser.");
         return "Error: Could not obtain a page in the headed browser.";
    }

    if (url && url.trim() !== '') {
        logActivity('open_browser', `Navigating to ${url}`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
        } catch (e) {
            logActivity('open_browser-error', `Failed to navigate to ${url}: ${(e as Error).message}`);
            // We don't abort, we still want the user to have the browser open
        }
    }

    logActivity('open_browser', "Waiting for the user to close the browser context...");

    // Pause execution until the user manually closes the persistent context (the whole browser)
    return new Promise((resolve) => {
        context.on('close', () => {
            logActivity('open_browser', "User closed the headed browser.");
            resolve("Browser session closed. Profile updated successfully.");
        });
    });
}
