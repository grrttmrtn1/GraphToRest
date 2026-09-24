import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../src/program';
import type { CliContext } from '../../src/runtime';
import type { Prompter } from '../../src/prompt';
import { tempPath, removeDb } from './harness';

export interface FakePrompterOptions {
  interactive?: boolean;
  /** Answers for ask()/askHidden(), consumed in order. */
  answers?: string[];
  confirm?: boolean;
}

export function fakePrompter(options: FakePrompterOptions = {}): Prompter & { asked: string[] } {
  const answers = [...(options.answers ?? [])];
  const asked: string[] = [];
  const next = async (question: string) => {
    asked.push(question);
    return answers.shift() ?? '';
  };
  return {
    asked,
    isInteractive: () => options.interactive ?? false,
    ask: next,
    askHidden: next,
    confirm: async (question) => {
      asked.push(question);
      return options.confirm ?? false;
    },
  };
}

export interface MakeCliOptions extends FakePrompterOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * A CLI context that never touches the real home directory: the profile lives in a temp file, and `dbPath` is a
 * fresh temp SQLite path for embedded-mode tests (pass it with --db).
 */
export function makeCli(options: MakeCliOptions = {}) {
  // writeProfile() chmods the profile's parent directory to 0700, which fails with EPERM when that
  // parent is os.tmpdir() itself (owned by root, e.g. /tmp): give it a freshly-owned subdirectory instead.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtr-cli-profile-'));
  const profileFile = path.join(profileDir, 'cli.json');
  const dbPath = tempPath('gtr-cli');
  let stdout = '';
  let stderr = '';
  const prompter = fakePrompter(options);
  const ctx: CliContext = {
    env: { GTR_PROFILE_PATH: profileFile, ...options.env },
    io: { out: (t) => { stdout += t; }, err: (t) => { stderr += t; } },
    prompter,
    fetchImpl: options.fetchImpl,
  };
  return {
    ctx,
    prompter,
    profileFile,
    dbPath,
    run: (argv: string[]) => runCli(argv, ctx),
    stdout: () => stdout,
    stderr: () => stderr,
    reset: () => {
      stdout = '';
      stderr = '';
    },
    cleanup: () => {
      fs.rmSync(profileDir, { recursive: true, force: true });
      removeDb(dbPath);
    },
  };
}
