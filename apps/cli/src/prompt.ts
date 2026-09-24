import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { CliError } from './errors';

export interface Prompter {
  isInteractive(): boolean;
  ask(question: string): Promise<string>;
  /** Input is not echoed. */
  askHidden(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

/** Prompts go to stderr so stdout stays clean for --json and pipes. */
export function createTtyPrompter(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): Prompter {
  const question = async (text: string, hidden: boolean): Promise<string> => {
    let muted = false;
    const sink = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) output.write(chunk, encoding);
        callback();
      },
    });
    const rl = readline.createInterface({ input, output: sink, terminal: true });
    const abort = new AbortController();
    rl.on('SIGINT', () => abort.abort());
    try {
      const answer = rl.question(text, { signal: abort.signal });
      muted = hidden;
      return await answer;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw new CliError('ABORTED', 'Aborted', 130);
      throw err;
    } finally {
      muted = false;
      if (hidden) output.write('\n');
      rl.close();
    }
  };

  return {
    isInteractive: () => Boolean(input.isTTY),
    ask: async (text) => (await question(text, false)).trim(),
    askHidden: (text) => question(text, true),
    confirm: async (text) => /^y(es)?$/i.test((await question(`${text} [y/N] `, false)).trim()),
  };
}
