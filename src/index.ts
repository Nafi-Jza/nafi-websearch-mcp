import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { runSearch } from "./tools/search.js";
import { scrapePage } from "./tools/scrape.js";
import { openBrowser } from "./tools/open.js";
import { getYouTubeTranscript } from "./tools/youtube.js";
import { closeBrowserContext } from "./browser.js";

const server = new Server({
    name: "websearch-mcp",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {}
    }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "search",
                description: "Search the web using DuckDuckGo.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The search query." }
                    },
                    required: ["query"]
                }
            },
            {
                name: "scrape",
                description: "Load a webpage and extract its main content as Markdown.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The URL of the webpage to scrape." }
                    },
                    required: ["url"]
                }
            },
            {
                name: "open_browser",
                description: "Open a headed browser window to manually solve CAPTCHAs or log into sites. Pauses the MCP server until the user closes the browser.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "An optional URL to navigate to when the browser opens." }
                    }
                }
            },
            {
                name: "youtube_transcript",
                description: "Extract the transcript from a YouTube video.",
                inputSchema: {
                    type: "object",
                    properties: {
                        target: { type: "string", description: "The YouTube video URL or ID." },
                        lang: { type: "string", description: "Optional preferred language code (e.g., 'en', 'es')." }
                    },
                    required: ["target"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case "search": {
                if (!args || typeof args.query !== 'string') {
                    throw new Error("Missing or invalid 'query' argument.");
                }
                const result = await runSearch(args.query);
                return { content: [{ type: "text", text: result }] };
            }

            case "scrape": {
                if (!args || typeof args.url !== 'string') {
                    throw new Error("Missing or invalid 'url' argument.");
                }
                const result = await scrapePage(args.url);
                return { content: [{ type: "text", text: result }] };
            }

            case "open_browser": {
                const url = args?.url && typeof args.url === 'string' ? args.url : undefined;
                const result = await openBrowser(url);
                return { content: [{ type: "text", text: result }] };
            }

            case "youtube_transcript": {
                if (!args || typeof args.target !== 'string') {
                    throw new Error("Missing or invalid 'target' argument.");
                }
                const lang = args.lang && typeof args.lang === 'string' ? args.lang : undefined;
                const result = await getYouTubeTranscript(args.target, lang);
                return { content: [{ type: "text", text: result }] };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        console.error(`Tool execution error in ${name}:`, error);
        return {
            content: [{ type: "text", text: `Error executing ${name}: ${(error as Error).message}` }],
            isError: true
        };
    }
});

async function run() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("WebSearch MCP Server running on stdio");
}

// Cleanup on exit
process.on('SIGINT', async () => {
    console.error("Closing browser and shutting down...");
    await closeBrowserContext();
    server.close(); process.exit(0);
});

run().catch(error => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
