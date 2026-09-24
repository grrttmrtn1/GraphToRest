#!/usr/bin/env node
import { runCli } from './program';
import { createTtyPrompter } from './prompt';

runCli(process.argv.slice(2), {
  env: process.env,
  io: { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
  prompter: createTtyPrompter(),
}).then((code) => {
  process.exitCode = code;
});
