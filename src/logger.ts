import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'activity.log');
const OUTPUT_DIR = path.join(process.cwd(), 'outputs');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

export function logActivity(activity: string) {
    const timestamp = new Date().toISOString();
    const logEntry = `\n[${timestamp}] ${activity}`;
    
    // We still log to stderr so the user can see it in real-time in the terminal
    // if they run it interactively, AND we append it to the log file.
    console.error(logEntry);
    
    try {
        fs.appendFileSync(LOG_FILE, logEntry + '\n');
    } catch (e) {
        console.error("Failed to write to log file", e);
    }
}

export function saveOutput(prefix: string, content: string, extension: string = 'md'): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${prefix}_${timestamp}.${extension}`;
    const filepath = path.join(OUTPUT_DIR, filename);
    
    try {
        fs.writeFileSync(filepath, content);
        return filepath;
    } catch (e) {
        console.error("Failed to save output file", e);
        return "Error saving file";
    }
}
