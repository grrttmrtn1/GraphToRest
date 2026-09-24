import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors';

export interface Profile {
  server: string;
  username: string;
  token: string;
  expiresAt: string;
}

export function profilePath(env: NodeJS.ProcessEnv): string {
  if (env.GTR_PROFILE_PATH) return env.GTR_PROFILE_PATH;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'graphtorest', 'cli.json');
}

function invalidProfile(file: string, reason: string): CliError {
  return new CliError('PROFILE_INVALID', `Cannot read the CLI profile ${file} (${reason}); run "gtr logout" to remove it`);
}

export function readProfile(file: string): Profile | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalidProfile(file, (err as NodeJS.ErrnoException).code ?? 'unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidProfile(file, 'not valid JSON');
  }
  const p = parsed as Partial<Profile> | null;
  const valid =
    typeof p === 'object' && p !== null &&
    typeof p.server === 'string' && typeof p.username === 'string' &&
    typeof p.token === 'string' && typeof p.expiresAt === 'string';
  if (!valid) throw invalidProfile(file, 'missing fields');
  return { server: p.server!, username: p.username!, token: p.token!, expiresAt: p.expiresAt! };
}

/**
 * Atomic write; the file holds a bearer token, so it is always created 0600. A directory this call creates
 * (e.g. a fresh ~/.config/graphtorest) is tightened to 0700 — mkdirSync's mode is subject to umask, so an
 * explicit chmod is still needed. A directory that already existed is left as is: GTR_PROFILE_PATH lets a user
 * point the profile anywhere (their home directory, /tmp, ...), and chmod-ing a directory we did not create
 * would silently change permissions the user did not ask us to touch, or fail outright (e.g. EPERM on /tmp).
 */
export function writeProfile(file: string, profile: Profile): void {
  const dir = path.dirname(file);
  const dirExisted = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!dirExisted) fs.chmodSync(dir, 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function deleteProfile(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
