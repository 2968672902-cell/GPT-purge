/**
 * agent-profile-patch — core engine
 *
 * Three patch kinds, each with an idempotent apply and a lossless revert:
 *
 *   insert-block      wrap a body in HTML comment markers inside a markdown file
 *   replace-once      locate an exact anchor string, substitute it once
 *   toml-key          set/insert one key inside a TOML section
 *
 * State machine per patch: applied | pending | drifted | skipped
 *   drifted = the file exists, the patch is not applied, and its anchor is gone.
 *             That means upstream changed the text we were matching against.
 *             This is the signal the whole tool exists to produce.
 */
import fs from 'node:fs';
import path from 'node:path';

const beginOf = (p) => p.begin ?? `<!-- apx:${p.id}:begin -->`;
const endOf = (p) => p.end ?? `<!-- apx:${p.id}:end -->`;

export function blockOf(p) {
  return `${beginOf(p)}\n${String(p.body ?? '').trimEnd()}\n${endOf(p)}`;
}

export function loadRegistry(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.patches)) throw new Error('registry: "patches" must be an array');
  const seen = new Set();
  for (const p of raw.patches) {
    if (!p.id) throw new Error('registry: every patch needs an "id"');
    if (seen.has(p.id)) throw new Error(`registry: duplicate patch id ${p.id}`);
    seen.add(p.id);
    if (!['insert-block', 'replace-once', 'toml-key'].includes(p.kind)) {
      throw new Error(`registry: patch ${p.id} has unknown kind "${p.kind}"`);
    }
  }
  return raw;
}

export function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeWithBackup(file, next) {
  const prev = readFileSafe(file);
  if (prev !== null) {
    const bak = `${file}.apx.bak`;
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, prev, 'utf8');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
}

/* ---------------------------------------------------------------- classify */

function classifyInsertBlock(doc, p) {
  if (doc === null) return 'pending';
  return doc.includes(beginOf(p)) ? 'applied' : 'pending';
}

function classifyReplaceOnce(doc, p) {
  if (doc === null) return 'drifted';
  if (doc.includes(p.replacement)) return 'applied';
  if (doc.includes(p.anchor)) return 'pending';
  return 'drifted';
}

function tomlRegion(lines, section) {
  if (!section) {
    const stop = lines.findIndex((l) => /^\s*\[/.test(l));
    return { start: 0, end: stop === -1 ? lines.length : stop };
  }
  const header = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (header === -1) return null;
  let i = header + 1;
  while (i < lines.length && !/^\s*\[/.test(lines[i])) i += 1;
  return { start: header + 1, end: i };
}

function findTomlKey(lines, p) {
  const region = tomlRegion(lines, p.section ?? '');
  if (!region) return { missingSection: true };
  for (let i = region.start; i < region.end; i += 1) {
    const m = lines[i].match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (m && m[1] === p.key) return { lineIndex: i, value: m[2].trim() };
  }
  return { region };
}

function classifyTomlKey(doc, p) {
  if (doc === null) return 'pending';
  const lines = doc.split(/\r?\n/);
  const found = findTomlKey(lines, p);
  // A missing section means "not applied yet", not upstream drift: apply() creates it.
  if (found.missingSection) return 'pending';
  if (found.lineIndex !== undefined) return found.value === p.value ? 'applied' : 'pending';
  return 'pending';
}

export function classify(doc, p) {
  switch (p.kind) {
    case 'insert-block': return classifyInsertBlock(doc, p);
    case 'replace-once': return classifyReplaceOnce(doc, p);
    case 'toml-key': return classifyTomlKey(doc, p);
    default: return 'skipped';
  }
}

/* ------------------------------------------------------------------- apply */

function applyInsertBlock(doc, p) {
  const block = blockOf(p);
  if (doc === null) return `${block}\n`;
  if (doc.includes(beginOf(p))) {
    const re = new RegExp(
      `${escapeRe(beginOf(p))}[\\s\\S]*?${escapeRe(endOf(p))}`,
      'm',
    );
    if (re.test(doc)) return doc.replace(re, block);
  }
  const sep = doc.endsWith('\n') ? '' : '\n';
  return `${doc}${sep}\n${block}\n`;
}

function applyReplaceOnce(doc, p) {
  if (doc.includes(p.replacement)) return doc;
  const idx = doc.indexOf(p.anchor);
  if (idx === -1) throw new Error(`anchor not found: ${JSON.stringify(p.anchor.slice(0, 60))}`);
  return doc.slice(0, idx) + p.replacement + doc.slice(idx + p.anchor.length);
}

function applyTomlKey(doc, p) {
  const lines = (doc ?? '').split(/\r?\n/);
  if (doc === null) lines.pop();
  const found = findTomlKey(lines, p);
  const line = `${p.key} = ${p.value}`;

  if (found.missingSection) {
    const tail = lines.length && lines[lines.length - 1].trim() === '' ? '' : '\n';
    return `${lines.join('\n')}${tail}\n[${p.section}]\n${line}\n`;
  }
  if (found.lineIndex !== undefined) {
    lines[found.lineIndex] = line;
    return lines.join('\n');
  }
  lines.splice(found.region.end, 0, line);
  return lines.join('\n');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function applyOne(doc, p) {
  switch (p.kind) {
    case 'insert-block': return applyInsertBlock(doc, p);
    case 'replace-once': return applyReplaceOnce(doc, p);
    case 'toml-key': return applyTomlKey(doc, p);
    default: return doc;
  }
}

/* ------------------------------------------------------------------ revert */

function revertOne(doc, p) {
  if (doc === null) return null;
  switch (p.kind) {
    case 'insert-block': {
      const re = new RegExp(
        `\\n?${escapeRe(beginOf(p))}[\\s\\S]*?${escapeRe(endOf(p))}\\n?`,
        'm',
      );
      return doc.replace(re, '\n');
    }
    case 'replace-once':
      return doc.includes(p.replacement) ? doc.replace(p.replacement, p.anchor) : doc;
    case 'toml-key': {
      const lines = doc.split(/\r?\n/);
      const found = findTomlKey(lines, p);
      if (found.lineIndex !== undefined) lines.splice(found.lineIndex, 1);
      return lines.join('\n');
    }
    default: return doc;
  }
}

/* --------------------------------------------------------------- orchestrate */

export function resolveTarget(p, { root, configDir }) {
  const base = p.target === 'codex-config' ? configDir : root;
  return path.resolve(base, p.file);
}

export function plan(registry, opts) {
  const byFile = new Map();
  for (const p of registry.patches) {
    if (p.target === 'chatgpt' && !opts.includeChatgpt) continue;
    const file = resolveTarget(p, opts);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(p);
  }
  const rows = [];
  for (const [file, patches] of byFile) {
    const doc = readFileSafe(file);
    for (const p of patches) {
      rows.push({ patch: p, file, doc, state: classify(doc, p) });
    }
  }
  return rows;
}

export function apply(registry, opts) {
  const rows = plan(registry, opts);
  const results = [];
  const byFile = new Map();
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, []);
    byFile.get(row.file).push(row);
  }
  for (const [file, fileRows] of byFile) {
    let doc = fileRows[0].doc;
    for (const row of fileRows) {
      if (row.state === 'applied') {
        results.push({ ...row, action: 'unchanged' });
        continue;
      }
      if (row.state === 'drifted') {
        results.push({ ...row, action: 'drifted' });
        continue;
      }
      if (row.state === 'skipped') {
        results.push({ ...row, action: 'skipped' });
        continue;
      }
      try {
        doc = applyOne(doc, row.patch);
        results.push({ ...row, action: opts.dryRun ? 'would-apply' : 'applied' });
      } catch (err) {
        results.push({ ...row, action: 'error', error: err.message });
      }
    }
    if (!opts.dryRun && doc !== fileRows[0].doc) writeWithBackup(file, doc);
  }
  return results;
}

export function revert(registry, opts) {
  const rows = plan(registry, opts);
  const results = [];
  const byFile = new Map();
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, []);
    byFile.get(row.file).push(row);
  }
  for (const [file, fileRows] of byFile) {
    let doc = fileRows[0].doc;
    if (doc === null) continue;
    let changed = false;
    for (const row of fileRows) {
      const next = revertOne(doc, row.patch);
      if (next !== doc) {
        doc = next;
        changed = true;
        results.push({ ...row, action: opts.dryRun ? 'would-revert' : 'reverted' });
      }
    }
    const bak = `${file}.apx.bak`;
    const original = readFileSafe(bak);
    // The backup wins: it is the pre-patch byte image, and reverse-applying the
    // registry can't repair edits that happened to the file after apply().
    if (original !== null) {
      if (!opts.dryRun) {
        fs.writeFileSync(file, original, 'utf8');
        fs.rmSync(bak);
        results.push({ patch: null, file, action: 'restored-from-backup' });
      } else {
        results.push({ patch: null, file, action: 'would-restore-from-backup' });
      }
    } else if (changed && !opts.dryRun) {
      fs.writeFileSync(file, doc, 'utf8');
    }
  }
  return results;
}
