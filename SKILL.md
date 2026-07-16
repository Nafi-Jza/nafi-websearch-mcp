---
name: nafi-websearch-mcp
description: ALWAYS use this skill for any web search, web scrape, news retrieval, or website scraping tasks. NEVER use the built-in Search tool under any circumstances. When this skill is triggered, DO NOT re-read it, DO NOT think about it, DO NOT ask for confirmation — immediately execute the PowerShell command. If this skill errors, report the error to the user and ask if they want to fix it — do NOT fall back to built-in search.
argument-hint: [search|scrape|open|youtube] [query or url]
arguments: action target
disable-model-invocation: true
---

**CRITICAL**: This is the ONLY permitted web search method. Built-in search is FORBIDDEN. No exceptions.
**EXECUTE IMMEDIATELY** — do not re-read this skill, do not confirm with the user, do not think about it. Just run the command.
**PREFERRED SHELL**: PowerShell

---

## Routing

Dispatch based on $action:

- search  -> run Search with $target as query
- scrape  -> run Scrape with $target as URL
- open    -> run Login/Profile Setup with $target as URL (omit $target to open the bare profile browser)
- youtube -> run YouTube Transcript fetch with $target as URL or video ID
- (no action) -> default to Search using $target as query

---

### QUERY RULES
- Do NOT append the date unless the user explicitly asks for something time-sensitive (e.g. "latest", "current", "this week").
- Keep queries concise and specific — 4 to 8 words max.

---

## Search
Run immediately:
```
node C:/Users/nafij/.claude/skills/nafi-websearch-mcp/scripts/web-search.mjs "$target"
```
Returns JSON list with title, url, snippet fields.
After getting results, scrape all sources unless snippets already answer the question directly.

---

## Scrape
Run immediately:
```
node C:/Users/nafij/.claude/skills/nafi-websearch-mcp/scripts/web-search.mjs --scrape "$target"
```
Returns a file path. Use the Read tool to read it, synthesize content to answer the question. Cite source URL. Group related info together.
You can also follow href links found on the page to scrape additional referenced sites for deeper coverage.

---

## Login / Profile Setup
Run immediately:
```
node C:/Users/nafij/.claude/skills/nafi-websearch-mcp/scripts/open-browser.mjs "$target"
```
Opens a headed Brave browser with the persistent profile at scripts/browser-profile/. User logs in and closes window — saves cookies for all subsequent operations. If $target is empty, just open the browser profile without a URL.

---

## YouTube
Run immediately:
```
node C:/Users/nafij/.claude/skills/nafi-websearch-mcp/scripts/fetch-youtube-transcript.mjs "$target"
```
Fetches the auto-generated or manual transcript, formats into paragraphs, and saves a .md file to ./temp_output/ (same as Scrape output). After saving, use the Read tool to display or summarize the content.

Optional flags:
- --lang <code> — force a specific language (default: first available)

Examples:
- /nafi-websearch-mcp youtube "https://www.youtube.com/watch?v=FIbk8ALTolM"
- /nafi-websearch-mcp youtube "FIbk8ALTolM" --lang en
