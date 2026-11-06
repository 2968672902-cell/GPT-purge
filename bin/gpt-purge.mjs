#!/usr/bin/env node
/**
 * apx — declarative, reversible config overlay for AI coding agents.
 *
 *   apx status   [--json]      show applied / pending / drifted per patch
 *   apx apply    [--dry]       apply pending patches, back up each file once
 *   apx revert                 restore originals from *.apx.bak
 *   apx budget <file> --kind chatgpt-custom|chatgpt-gpt|codex-agents
 *
 * Exit codes: 0 clean · 1 usage or IO error · 2 drift detected
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadRegistry, plan, apply, revert } from '../src/patcher.mjs';
import { budget, formatBudget } from '../src/targets.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) args[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { args[k] = argv[i + 1]; i += 1; }
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'status';
const root = path.resolve(args.root ?? process.cwd());
const configDir = path.resolve(args.config ?? path.join(os.homedir(), '.codex'));
const registryFile = path.resolve(args.registry ?? path.join(root, 'patches', 'registry.json'));
const opts = { root, configDir, dryRun: Boolean(args.dry), includeChatgpt: args.chatgpt !== false };

const SYMBOL = { applied: '✓', pending: '·', drifted: '!', skipped: '-' };

function fail(msg) {
  process.stderr.write(`apx: ${msg}\n`);
  process.exit(1);
}

const COMMANDS = ['status', 'apply', 'revert', 'budget'];
if (!COMMANDS.includes(cmd)) fail(`unknown command "${cmd}" (${COMMANDS.join(' | ')})`);

if (cmd === 'budget') {
  const file = args._[1];
  const kind = args.kind ?? 'chatgpt-custom';
  if (!file) fail('usage: apx budget <file> --kind chatgpt-custom|chatgpt-gpt|codex-agents');
  const text = fs.readFileSync(path.resolve(root, file), 'utf8');
  const r = budget(text, kind);
  process.stdout.write(`${formatBudget(r)}\n`);
  process.exit(r.ok ? 0 : 2);
}

if (!fs.existsSync(registryFile)) fail(`no registry at ${registryFile} (pass --registry)`);
const registry = loadRegistry(registryFile);

if (cmd === 'status') {
  const rows = plan(registry, opts);
  const counts = { applied: 0, pending: 0, drifted: 0, skipped: 0 };
  for (const r of rows) counts[r.state] += 1;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ root, configDir, counts, rows: rows.map((r) => ({
      id: r.patch.id, kind: r.patch.kind, file: r.file, state: r.state,
    })) }, null, 2)}\n`);
  } else {
    const width = Math.max(...rows.map((r) => r.patch.id.length), 4);
    for (const r of rows) {
      const rel = path.relative(root, r.file) || r.file;
      process.stdout.write(`${SYMBOL[r.state]} ${r.patch.id.padEnd(width)}  ${r.state.padEnd(8)} ${rel}\n`);
    }
    process.stdout.write(
      `\n${counts.applied} applied · ${counts.pending} pending · ${counts.drifted} drifted · ` +
      `${counts.skipped} skipped  (${rows.length} patches, root ${root})\n`,
    );
  }
  process.exit(counts.drifted > 0 ? 2 : 0);
}

if (cmd === 'apply') {
  const results = apply(registry, opts);
  for (const r of results) {
    const rel = path.relative(root, r.file) || r.file;
    const suffix = r.error ? `  ← ${r.error}` : '';
    process.stdout.write(`${{ applied: '✓', unchanged: '=', drifted: '!', skipped: '-', error: 'x' }[r.action]} ` +
      `${r.patch.id.padEnd(28)} ${r.action.padEnd(9)} ${rel}${suffix}\n`);
  }
  const bad = results.filter((r) => r.action === 'error' || r.action === 'drifted');
  if (opts.dryRun) process.stdout.write('\n(dry run — nothing written)\n');
  process.exit(bad.length ? 2 : 0);
}

if (cmd === 'revert') {
  const results = revert(registry, opts);
  if (!results.length) process.stdout.write('nothing to revert\n');
  for (const r of results) {
    const rel = path.relative(root, r.file ?? '') || r.file;
    process.stdout.write(`- ${(r.patch?.id ?? 'file').padEnd(28)} ${r.action.padEnd(20)} ${rel}\n`);
  }
  process.exit(0);
}

