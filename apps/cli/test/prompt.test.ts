import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createTtyPrompter } from '../src/prompt';

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => {
    written += chunk.toString();
  });
  return { input, output, written: () => written };
}

describe('createTtyPrompter', () => {
  it('reports interactivity from input.isTTY', () => {
    const { input, output } = streams();
    expect(createTtyPrompter(input, output).isInteractive()).toBe(false);
    expect(createTtyPrompter(Object.assign(input, { isTTY: true }), output).isInteractive()).toBe(true);
  });

  it('asks a question and trims the answer', async () => {
    const { input, output, written } = streams();
    const answer = createTtyPrompter(input, output).ask('Username: ');
    input.write('  admin  \n');
    expect(await answer).toBe('admin');
    expect(written()).toContain('Username: ');
  });

  it('does not echo a hidden answer', async () => {
    const { input, output, written } = streams();
    const answer = createTtyPrompter(input, output).askHidden('Password: ');
    input.write('s3cret-value\n');
    expect(await answer).toBe('s3cret-value');
    expect(written()).toContain('Password: ');
    expect(written()).not.toContain('s3cret-value');
  });

  it('rejects with ABORTED (exit 130) on Ctrl+C, without echoing a hidden answer typed so far', async () => {
    const { input, output, written } = streams();
    const answer = createTtyPrompter(input, output).askHidden('Password: ');
    input.write('half-typed');
    input.write('\x03');
    await expect(answer).rejects.toMatchObject({ code: 'ABORTED', exitCode: 130 });
    expect(written()).not.toContain('half-typed');
  });

  it('confirms only on y or yes', async () => {
    for (const [typed, expected] of [['y', true], ['YES', true], ['', false], ['n', false]] as const) {
      const { input, output } = streams();
      const answer = createTtyPrompter(input, output).confirm('Delete?');
      input.write(`${typed}\n`);
      expect(await answer).toBe(expected);
    }
  });
});
