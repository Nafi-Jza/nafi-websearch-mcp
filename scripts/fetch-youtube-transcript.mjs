import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMP_OUTPUT_DIR = path.join(__dirname, 'temp_output');
const PROFILE_DIR = path.join(__dirname, 'browser-profile');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getBravePath() {
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  } else if (process.platform === 'darwin') {
    return '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
  } else {
    return '/usr/bin/brave-browser';
  }
}

function extractVideoId(urlOrId) {
  const cleaned = urlOrId.trim();
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
  return null;
}

function extractPlayerResponse(html) {
  const marker = 'ytInitialPlayerResponse = ';
  const startIdx = html.indexOf(marker);
  if (startIdx !== -1) {
    const content = html.substring(startIdx + marker.length);
    const match = content.match(/^({.+?});\s*(?:var|window|function|<\/script>)/s);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {}
    }
  }

  const altMatch = html.match(/"ytInitialPlayerResponse"\s*:\s*({.+?})(?:,"|,"|})/);
  if (altMatch) {
    try {
      return JSON.parse(altMatch[1]);
    } catch (e) {}
  }

  return null;
}

function selectTrack(captionTracks, requestedLang) {
  let track = captionTracks.find(t => t.languageCode === requestedLang);
  if (track) return { track, translate: false };

  if (requestedLang) {
    const baseLang = requestedLang.split('-')[0];
    track = captionTracks.find(t => t.languageCode.startsWith(baseLang));
    if (track) return { track, translate: false };
  }

  track = captionTracks.find(t => t.languageCode === 'en');
  if (track) return { track, translate: false };

  track = captionTracks.find(t => t.languageCode.startsWith('en'));
  if (track) return { track, translate: false };

  if (requestedLang && captionTracks[0].isTranslatable) {
    return { track: captionTracks[0], translate: true, targetLang: requestedLang };
  }

  return { track: captionTracks[0], translate: false };
}

async function fetchTranscriptXml(baseUrl, cookieString = '') {
  const headers = {
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

async function fetchTranscriptWithPlaywright(videoId, requestedLang) {
  console.error('Direct fetch failed or blocked. Launching browser fallback...');

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

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const data = await page.evaluate(() => {
      const playerResponse = window.ytInitialPlayerResponse;
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
    if (translate) {
      urlObj.searchParams.set('tlang', targetLang);
    }
    let finalUrl = urlObj.toString();

    console.error(`[DEBUG Playwright] Requesting track URL: ${finalUrl}`);

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
    await context.close();
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseTranscriptXml(xmlText) {
  const regex = /<text[^>]*start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  const result = [];
  while ((match = regex.exec(xmlText)) !== null) {
    const start = parseFloat(match[1]);
    const text = decodeHtmlEntities(match[2]);
    result.push({ text, start });
  }
  return result;
}

function processTranscript(transcriptItems) {
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

function sanitizeFilename(title) {
  let slug = title.normalize('NFD').replace(/[̀-ͯ]/g, '');
  slug = slug.replace(/&/g, 'and');
  slug = slug.replace(/\s+/g, '-');
  slug = slug.replace(/[^0-9A-Za-z._-]/g, '');
  slug = slug.replace(/-{2,}/g, '-');
  slug = slug.replace(/^[-_.]+|[-_.]+$/g, '');
  return slug.toLowerCase().substring(0, 100);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Usage:
  node fetch-youtube-transcript.mjs <youtube_url_or_id> [--lang <code>]

Examples:
  node fetch-youtube-transcript.mjs https://www.youtube.com/watch?v=FIbk8ALTolM
  node fetch-youtube-transcript.mjs FIbk8ALTolM --lang en
`);
    process.exit(1);
  }

  let urlOrId = '';
  let lang = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang') {
      lang = args[i + 1];
      i++;
    } else if (!urlOrId) {
      urlOrId = args[i];
    }
  }

  return { urlOrId, lang };
}

async function main() {
  const { urlOrId, lang } = parseArgs();
  const videoId = extractVideoId(urlOrId);

  if (!videoId) {
    console.error(`[ERR] Invalid YouTube URL or ID: ${urlOrId}`);
    process.exit(1);
  }

  let title = 'Unknown Title';
  let author = 'Unknown Channel';
  let xmlText = '';
  let availableLangs = [];

  try {
    console.error(`Fetching metadata and transcript for: ${videoId}`);
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
    const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1];
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

    availableLangs = captionTracks.map(t => t.languageCode);
    console.error(`[VIDEO] ${title}`);
    console.error(`[CHANNEL] ${author}`);
    console.error(`[LANG] Available: ${availableLangs.join(', ')}`);

    const { track, translate, targetLang } = selectTrack(captionTracks, lang);
    const urlObj = new URL(track.baseUrl);
    urlObj.searchParams.set('fmt', 'srv1');
    if (translate) {
      urlObj.searchParams.set('tlang', targetLang);
      console.error(`[LANG] Requesting translation to: ${targetLang}`);
    } else {
      console.error(`[LANG] Using: ${track.languageCode}`);
    }
    let fetchUrl = urlObj.toString();

    xmlText = await fetchTranscriptXml(fetchUrl);
    if (!xmlText || xmlText.trim().length === 0) {
      throw new Error('Transcript content is empty.');
    }

  } catch (directError) {
    console.error(`[INFO] Direct fetch failed: ${directError.message}`);
    try {
      const result = await fetchTranscriptWithPlaywright(videoId, lang);
      title = result.title;
      author = result.author;
      xmlText = result.xmlText;
      availableLangs = result.captionTracks.map(t => t.languageCode);

      console.error(`[VIDEO] ${title}`);
      console.error(`[CHANNEL] ${author}`);
      console.error(`[LANG] Available: ${availableLangs.join(', ')}`);
    } catch (playwrightError) {
      console.error(`[ERR] All transcript fetch methods failed.`);
      console.error(`Direct Fetch Error: ${directError.message}`);
      console.error(`Playwright Error: ${playwrightError.message}`);
      process.exit(1);
    }
  }

  const segments = parseTranscriptXml(xmlText);
  if (segments.length === 0) {
    console.error('[ERR] Transcript XML fetched but could not parse any text lines.');
    process.exit(1);
  }

  const paragraphs = processTranscript(segments);
  const content = `# ${title}\n\n` + paragraphs.join('\n\n');

  if (!fs.existsSync(TEMP_OUTPUT_DIR)) {
    fs.mkdirSync(TEMP_OUTPUT_DIR, { recursive: true });
  }

  const slug = sanitizeFilename(title);
  const rand = crypto.randomBytes(4).toString('hex');
  const filename = `${slug}_${rand}.md`;
  const outputPath = path.join(TEMP_OUTPUT_DIR, filename);

  fs.writeFileSync(outputPath, content, 'utf-8');

  console.log(`[OK] Saved to ${outputPath}`);
  console.log(`[STATS] ${paragraphs.length} paragraphs, ${content.length} chars`);
}

main().catch(e => {
  console.error('[FATAL ERR]', e);
  process.exit(1);
});
