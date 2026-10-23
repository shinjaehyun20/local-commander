import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const local = createRequire(import.meta.url);
const existing = createRequire(path.join(process.env.LOCAL_COMMANDER_VENDOR || path.join(os.homedir(), '.local-commander/vendor'), 'package.json'));
export async function dependency(name) {
  let resolved;
  try { resolved = local.resolve(name); } catch { resolved = existing.resolve(name); }
  return import(pathToFileURL(resolved).href);
}
