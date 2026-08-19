// Package-test isolation for production config-load side effects. Every test
// process gets a private grandfather directory, and child processes inherit it.
// CommonJS + --require preserves Loop Studio's Node >=18.17 runtime floor.
// A caller-supplied override wins so dedicated sidecar tests can own fixtures.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

if (!process.env.STUDIO_GRANDFATHER_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'camus-studio-grandfather-test-'));
  process.env.STUDIO_GRANDFATHER_DIR = dir;
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
}
