import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, classify, apply, revert, plan, blockOf } from '../src/patcher.mjs';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent rules\n\nexisting line\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'patches'));
  fs.writeFileSync(
    path.join(dir, 'patches', 'registry.json'),
    JSON.stringify({
      version: 1,
      patches: [
        { id: 'BLOCK', kind: 'insert-block', target: 'codex', file: 'AGENTS.md', body: 'house rule' },
        {
          id: 'ANCHOR', kind: 'replace-once', target: 'codex', file: 'AGENTS.md',
          anchor: 'existing line', replacement: 'existing line (patched)',
        },
        {
          id: 'TOML', kind: 'toml-key', target: 'codex-config', file: 'config.toml',
          section: '', key: 'approval_policy', value: '"on-request"',
        },
        {
          id: 'TOML_SECTION', kind: 'toml-key', target: 'codex-config', file: 'config.toml',
          section: 'sandbox_workspace_write', key: 'network_access', value: 'false',
        },
      ],
    }),
    'utf8',
  );
  return dir;
}

const optsFor = (dir) => ({
  root: dir,
  configDir: path.join(dir, 'codexhome'),
  includeChatgpt: true,
  dryRun: false,
});

test('apply is idempotent', () => {
  const dir = sandbox();
  const reg = loadRegistry(path.join(dir, 'patches', 'registry.json'));
  apply(reg, optsFor(dir));
  const afterFirst = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  const second = apply(reg, optsFor(dir));
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), afterFirst);
  assert.ok(second.every((r) => r.action === 'unchanged'));
});

test('insert-block writes markers and one backup', () => {
  const dir = sandbox();
  const reg = loadRegistry(path.join(dir, 'patches', 'registry.json'));
  apply(reg, optsFor(dir));
  const doc = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(doc.includes('<!-- apx:BLOCK:begin -->'));
  assert.ok(doc.includes('house rule'));
  assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md.apx.bak')));
});

test('toml-key creates a missing section', () => {
  const dir = sandbox();
  const reg = loadRegistry(path.join(dir, 'patches', 'registry.json'));
  apply(reg, optsFor(dir));
  const toml = fs.readFileSync(path.join(dir, 'codexhome', 'config.toml'), 'utf8');
  assert.match(toml, /^approval_policy = "on-request"$/m);
  assert.match(toml, /^\[sandbox_workspace_write\]$/m);
  assert.match(toml, /^network_access = false$/m);
});

test('drift is reported when the anchor disappears', () => {
  const dir = sandbox();
  const reg = loadRegistry(path.join(dir, 'patches', 'registry.json'));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent rules\n\nrewritten upstream\n', 'utf8');
  const rows = plan(reg, optsFor(dir));
  const anchor = rows.find((r) => r.patch.id === 'ANCHOR');
  assert.equal(anchor.state, 'drifted');
});

test('applied beats drift when replacement is already present', () => {
  const dir = sandbox();
  const reg = loadRegistry(path.join(dir, 'patches', 'registry.json'));
  const doc = '# Agent rules\n\nexisting line (patched)\n';
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), doc, 'utf8');
  const p = reg.patches.find((x) => x.id === 'ANCHOR');
  assert.equal(classify(doc, p), 'applied');
});

test('revert restores the backup byte for byte', () => {
  const dir = sandbox();
  const reg = loadRegistry(path.join(dir, 'patches', 'registry.json'));
  const original = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  apply(reg, optsFor(dir));
  revert(reg, optsFor(dir));
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md.apx.bak')), false);
});

test('blockOf keeps the body verbatim between markers', () => {
  const b = blockOf({ id: 'X', body: 'a\nb\n' });
  assert.equal(b, '<!-- apx:X:begin -->\na\nb\n<!-- apx:X:end -->');
});

test('registry rejects duplicate ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-'));
  const f = path.join(dir, 'r.json');
  fs.writeFileSync(f, JSON.stringify({ patches: [
    { id: 'A', kind: 'insert-block' }, { id: 'A', kind: 'insert-block' },
  ] }));
  assert.throws(() => loadRegistry(f), /duplicate patch id A/);
});
