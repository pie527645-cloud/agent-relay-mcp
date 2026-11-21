#!/usr/bin/env node
import { runCli } from './cliRunner.js';

runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal CLI error: ${message}\n`);
    process.exitCode = 1;
  }
);
