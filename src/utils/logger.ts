import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Logs always in project root (one level up from src/utils)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const LOG_FILE = path.join(PROJECT_ROOT, 'activity.log');
export const OUTPUT_DIR = path.join(PROJECT_ROOT, 'outputs');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

export function logActivity(context: string, message: string) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${context}] ${message}\n`;
    try { fs.appendFileSync(LOG_FILE, formattedMessage); } catch {}
    console.error(formattedMessage.trim());
}

export function saveOutput(prefix: string, content: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${prefix}_${timestamp}.md`;
    const filepath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filepath, content);
    logActivity('file-system', `Saved output to: ${filepath}`);
    return filepath;
}
