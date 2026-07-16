import fs from 'fs';
import path from 'path';

// Define log file paths
export const LOG_FILE = path.join(process.cwd(), 'activity.log');
export const OUTPUT_DIR = path.join(process.cwd(), 'outputs');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Ensure log file exists
if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, '');
}

/**
 * Appends a log message to the activity.log file and also logs it to stderr.
 */
export function logActivity(context: string, message: string) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${context}] ${message}\n`;

    // Write to file for 'npm run watch'
    fs.appendFileSync(LOG_FILE, formattedMessage);

    // Also write to stderr so it's visible in MCP inspector/debug modes
    console.error(formattedMessage.trim());
}

/**
 * Saves a markdown output to the outputs/ directory.
 */
export function saveOutput(prefix: string, content: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${prefix}_${timestamp}.md`;
    const filepath = path.join(OUTPUT_DIR, filename);

    fs.writeFileSync(filepath, content);
    logActivity('file-system', `Saved output to: ${filepath}`);

    return filepath;
}
