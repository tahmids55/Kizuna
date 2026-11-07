/**
 * Load `.env` (if present) before anything reads configuration.
 * Real environment variables always win; tests opt out with KIZUNA_SKIP_DOTENV.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (!process.env.KIZUNA_SKIP_DOTENV && fs.existsSync(file)) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  } else {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq > 0) {
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
      }
    }
  }
}

if (process.env.RENDER && !process.env.DATABASE_URL?.trim()) {
  // Without this, the app would fall back to an embedded database on Render's
  // ephemeral disk and silently lose everything on the next restart.
  console.error('\n✗ DATABASE_URL is not set. Add your Neon connection string in Render → Environment.\n');
  process.exit(1);
}
