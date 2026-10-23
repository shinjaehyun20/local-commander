import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export const getStateDir = () =>
  path.resolve(
    process.env.LOCAL_COMMANDER_STATE ||
      path.join(process.env.LOCALAPPDATA || os.homedir(), 'local-commander')
  );

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJsonIfExists(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new Error(`Unable to read state file ${file}: ${err.message}`, { cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`;
    try {
      fs.copyFileSync(file, backup);
    } catch {
      // Best-effort backup; still throw below so caller never overwrites corrupt state.
    }
    const error = new Error(
      `Corrupt JSON in state file ${file}; original preserved at ${backup}: ${err.message}`,
      { cause: err }
    );
    error.code = 'ERR_CORRUPT_STATE_JSON';
    error.corruptBackupPath = backup;
    throw error;
  }
}

export function writeSecureJson(file, value) {
  const dir = ensureDir(path.dirname(file));
  const payload = JSON.stringify(value, null, 2);
  const tmpFile = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  try {
    fs.writeFileSync(tmpFile, payload, { mode: 0o600 });
    try {
      fs.chmodSync(tmpFile, 0o600);
    } catch {
      // Windows ACLs may ignore POSIX chmod bits.
    }
    fs.renameSync(tmpFile, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Ignore chmod no-op on Windows.
    }
  } finally {
    if (fs.existsSync(tmpFile)) {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}
