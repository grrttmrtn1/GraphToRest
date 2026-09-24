import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempPath, removeDb } from './helpers/harness';

const cliDir = path.resolve(__dirname, '..');
const bin = path.join(cliDir, 'bin', 'gtr.js');
const dbPath = tempPath('gtr-smoke');
const profile = tempPath('gtr-smoke-profile', '.json');

function gtr(args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GTR_PROFILE_PATH: profile, DB_PATH: dbPath },
  });
}

beforeAll(() => {
  execFileSync('npx', ['tsc', '-p', cliDir], { stdio: 'inherit' });
}, 120_000);

afterAll(() => {
  removeDb(dbPath);
  fs.rmSync(profile, { force: true });
});

describe('gtr binary', () => {
  it('runs status in embedded mode and exits 0', () => {
    const result = gtr(['status']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('mode: embedded');
  });

  it('exits 2 for an unknown command', () => {
    expect(gtr(['connection-create']).status).toBe(2);
  });

  it('round-trips a connection through the real binary', () => {
    expect(gtr(['connection', 'create', '--name', 'smoke', '--adapter-type', 'mock', '--auth-mode', 'passthrough']).status).toBe(0);
    const listed = gtr(['connection', 'list', '--json']);
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ name: 'smoke' })]);
  });
});
