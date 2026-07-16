import { getBrowserContext, USER_AGENT, PROFILE_DIR, getBravePath } from '../browser.js';
import { chromium } from 'playwright';
import { logActivity, saveOutput } from '../utils/logger.js';

function extractVideoId(target: string): string {
    const cleaned = target.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(cleaned)) {
        return cleaned;
    }
    const regexes = [
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
        /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const regex of regexes) {
        const match = cleaned.match(regex);
        if (match) return match[1];
    }
    return '';
}

function selectTrack(captionTracks: any[], requestedLang?: string) {
    let track = captionTracks.find((t: any) => t.languageCode === requestedLang);
    if (track) return { track, translate: false };

    if (requestedLang) {
        const baseLang = requestedLang.split('-')[0];
        track = captionTracks.find((t: any) => t.languageCode.startsWith(baseLang!));
        if (track) return { track, translate: false };
    }

    track = captionTracks.find((t: any) => t.languageCode === 'en');
    if (track) return { track, translate: false };

    track = captionTracks.find((t: any) => t.languageCode.startsWith('en'));
    if (track) return { track, translate: false };

    if (requestedLang && captionTracks[0].isTranslatable) {
        return { track: captionTracks[0], translate: true, targetLang: requestedLang };
    }

    return { track: captionTracks[0], translate: false };
}

async function fetchTranscriptXml(baseUrl: string, cookieString = '') {
    const headers: any = {
        'User-Agent': 'python-requests/2.31.0',
        'Accept-Language': 'en-US,en;q=0.9',
    };
    if (cookieString) {
        headers['Cookie'] = cookieString;
    }
    const response = await fetch(baseUrl, { headers });
    if (!response.ok) {
        throw new Error(`Failed to fetch transcript XML: HTTP ${response.status}`);
    }
    return await response.text();
}

function decodeHtmlEntities(str: string) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

function parseTranscriptXml(xmlText: string) {
    const regex = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let match;
    const result = [];
    while ((match = regex.exec(xmlText)) !== null) {
        const start = parseFloat(match[1] as string);
        const text = decodeHtmlEntities(match[2] as string);
        result.push({ text, start });
    }
    return result;
}

function processTranscript(transcriptItems: {text: string, start: number}[]) {
    const texts = transcriptItems.map(item => item.text || '');
    let fullText = texts.join(' ');
    fullText = fullText.replace(/\[?\d+:\d+\]?/g, '');

    const sentences = fullText.split(/(?<=[.!?])\s+/);
    const paragraphs = [];
    let current = [];

    for (const sentence of sentences) {
        if (sentence.trim()) {
            current.push(sentence.trim());
            if (current.length >= 3) {
                paragraphs.push(current.join(' '));
                current = [];
            }
        }
    }
    if (current.length > 0) {
        paragraphs.push(current.join(' '));
    }
    return paragraphs;
}

async function fetchTranscriptWithPlaywright(videoId: string, requestedLang?: string) {
    logActivity('youtube', 'Direct fetch failed or blocked. Launching browser fallback...');

    // We use the same persistent context as the rest of the app, ensuring login state is shared.
    const context = await getBrowserContext(false);
    const page = await context.newPage();

    try {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        await page.waitForTimeout(2000);

        const data = await page.evaluate(() => {
            const playerResponse = (window as any).ytInitialPlayerResponse;
            if (!playerResponse) return null;
            return {
                title: playerResponse.videoDetails?.title || 'Unknown Title',
                author: playerResponse.videoDetails?.author || 'Unknown Channel',
                captionTracks: playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [],
            };
        });

        if (!data || !data.captionTracks || data.captionTracks.length === 0) {
            throw new Error('Transcripts disabled or no caption tracks found in browser.');
        }

        const { track, translate, targetLang } = selectTrack(data.captionTracks, requestedLang);
        const urlObj = new URL(track.baseUrl);
        urlObj.searchParams.set('fmt', 'srv1');
        if (translate && targetLang) {
            urlObj.searchParams.set('tlang', targetLang);
        }
        const finalUrl = urlObj.toString();

        logActivity('youtube-debug', `Requesting track URL from browser: ${finalUrl}`);

        const xmlText = await page.evaluate(async (fetchUrl) => {
            const response = await fetch(fetchUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        }, finalUrl);

        return {
            title: data.title,
            author: data.author,
            xmlText,
            captionTracks: data.captionTracks,
        };
    } finally {
        await page.close();
    }
}

export async function getYouTubeTranscript(target: string, lang?: string): Promise<string> {
    const videoId = extractVideoId(target);

    if (!videoId) {
        logActivity('youtube-error', `Invalid YouTube URL or ID: ${target}`);
        return `[ERR] Invalid YouTube URL or ID: ${target}`;
    }

    let title = 'Unknown Title';
    let author = 'Unknown Channel';
    let xmlText = '';

    try {
        logActivity('youtube', `Fetching metadata and transcript for: ${videoId}`);
        const watchResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        if (!watchResponse.ok) {
            throw new Error(`HTTP status ${watchResponse.status}`);
        }

        const html = await watchResponse.text();
        const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/);
        const apiKey = apiKeyMatch?.[1];

        if (!apiKey) {
            throw new Error('Could not parse INNERTUBE_API_KEY from watch page.');
        }

        const playerResponse = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
                videoId: videoId
            })
        });

        if (!playerResponse.ok) {
            throw new Error(`InnerTube player status ${playerResponse.status}`);
        }

        const playerData = await playerResponse.json();

        title = playerData.videoDetails?.title || 'Unknown Title';
        author = playerData.videoDetails?.author || 'Unknown Channel';

        const captionTracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (captionTracks.length === 0) {
            throw new Error('No transcript tracks available on this video.');
        }

        const availableLangs = captionTracks.map((t: any) => t.languageCode);
        logActivity('youtube-info', `Title: ${title} | Channel: ${author} | Langs: ${availableLangs.join(', ')}`);

        const { track, translate, targetLang } = selectTrack(captionTracks, lang);
        const urlObj = new URL(track.baseUrl);
        urlObj.searchParams.set('fmt', 'srv1');
        if (translate && targetLang) {
            urlObj.searchParams.set('tlang', targetLang);
            logActivity('youtube-info', `Requesting translation to: ${targetLang}`);
        } else {
            logActivity('youtube-info', `Using track: ${track.languageCode}`);
        }
        const fetchUrl = urlObj.toString();

        xmlText = await fetchTranscriptXml(fetchUrl);
        if (!xmlText || xmlText.trim().length === 0) {
            throw new Error('Transcript content is empty.');
        }

    } catch (directError) {
        logActivity('youtube-warning', `Direct fetch failed: ${(directError as Error).message}`);
        try {
            const result = await fetchTranscriptWithPlaywright(videoId, lang);
            title = result.title;
            author = result.author;
            xmlText = result.xmlText;
        } catch (playwrightError) {
            logActivity('youtube-error', `All transcript fetch methods failed.`);
            logActivity('youtube-error', `Direct Fetch Error: ${(directError as Error).message}`);
            logActivity('youtube-error', `Playwright Error: ${(playwrightError as Error).message}`);
            return "Error: Could not extract transcript via any method.";
        }
    }

    const segments = parseTranscriptXml(xmlText);
    if (segments.length === 0) {
        logActivity('youtube-error', 'Transcript XML fetched but could not parse any text lines.');
        return '[ERR] Transcript XML fetched but could not parse any text lines.';
    }

    const paragraphs = processTranscript(segments);
    const content = `# ${title}\n\n` + paragraphs.join('\n\n');

    logActivity('youtube-success', `Successfully extracted transcript (${paragraphs.length} paragraphs).`);

    // Save output
    saveOutput(`youtube_${videoId}`, content);

    return content;
}
