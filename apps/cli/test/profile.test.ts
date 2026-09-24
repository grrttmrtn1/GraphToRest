import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profilePath, readProfile, writeProfile, deleteProfile, type Profile } from '../src/profile';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtr-profile-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PROFILE: Profile = { server: 'http://localhost:3000', username: 'admin', token: 'tok', expiresAt: '2026-09-24T00:00:00.000Z' };

describe('profilePath', () => {
  it('prefers GTR_PROFILE_PATH, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(profilePath({ GTR_PROFILE_PATH: '/x/p.json', XDG_CONFIG_HOME: '/xdg' })).toBe('/x/p.json');
    expect(profilePath({ XDG_CONFIG_HOME: '/xdg' })).toBe(path.join('/xdg', 'graphtorest', 'cli.json'));
    expect(profilePath({})).toBe(path.join(os.homedir(), '.config', 'graphtorest', 'cli.json'));
  });
});

describe('profile file', () => {
  it('round-trips with 0700 directory and 0600 file permissions and no temp file left behind', () => {
    const file = path.join(tempDir(), 'nested', 'cli.json');
    writeProfile(file, PROFILE);
    expect(readProfile(file)).toEqual(PROFILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['cli.json']);
  });

  it('leaves an already-existing directory\'s permissions alone (GTR_PROFILE_PATH may point anywhere)', () => {
    const dir = tempDir();
    fs.chmodSync(dir, 0o755);
    const file = path.join(dir, 'cli.json');
    writeProfile(file, PROFILE);
    expect(readProfile(file)).toEqual(PROFILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('returns null when there is no file', () => {
    expect(readProfile(path.join(tempDir(), 'missing.json'))).toBeNull();
  });

  it('rejects a malformed file with a message naming the path and "gtr logout"', () => {
    const file = path.join(tempDir(), 'cli.json');
    fs.writeFileSync(file, '{not json');
    expect(() => readProfile(file)).toThrow(expect.objectContaining({ code: 'PROFILE_INVALID' }));
    expect(() => readProfile(file)).toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*gtr logout`));
    fs.writeFileSync(file, JSON.stringify({ server: 'http://x' }));
    expect(() => readProfile(file)).toThrow(/gtr logout/);
  });

  it('deletes a profile, including a malformed one, and reports whether it existed', () => {
    const file = path.join(tempDir(), 'cli.json');
    fs.writeFileSync(file, 'garbage');
    expect(deleteProfile(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(deleteProfile(file)).toBe(false);
  });
});
