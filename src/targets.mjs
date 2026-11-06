/**
 * Per-target facts and budget checks.
 *
 * Each agent reads configuration from a different place, and two of them
 * silently truncate. Keeping the limits here means the registry can stay
 * portable while `apx budget` tells you the truth about what actually lands.
 */

export const TARGETS = {
  codex: {
    label: 'Codex CLI',
    root: 'repo',
    reads: ['AGENTS.md (repo root, plus nested ones)', '~/.codex/config.toml'],
    notes:
      'config.toml is loaded from CODEX_HOME, default ~/.codex. AGENTS.md is walked ' +
      'from the repo root down to the file being edited; nested files win.',
  },
  chatgpt: {
    label: 'ChatGPT',
    root: 'repo',
    reads: ['Custom instructions (profile)', 'GPT / Project instructions'],
    notes:
      'Pasted by hand — there is no file hook. Custom instructions truncate at ' +
      '1500 characters per field; GPT instructions around 8000.',
  },
};

/** Hard limits, measured in characters after trimming. */
export const LIMITS = {
  'chatgpt-custom': 1500,
  'chatgpt-gpt': 8000,
  'codex-agents': 32768,
};

export function budget(text, kind) {
  const limit = LIMITS[kind];
  if (!limit) throw new Error(`unknown budget kind "${kind}" (have: ${Object.keys(LIMITS).join(', ')})`);
  const chars = (text ?? '').length;
  return {
    kind,
    chars,
    limit,
    remaining: limit - chars,
    over: Math.max(0, chars - limit),
    ok: chars <= limit,
  };
}

export function formatBudget(r) {
  const pct = r.limit ? Math.round((r.chars / r.limit) * 100) : 0;
  const state = r.ok ? 'ok' : `OVER by ${r.over}`;
  return `${r.kind}: ${r.chars}/${r.limit} chars (${pct}%) — ${state}`;
}
