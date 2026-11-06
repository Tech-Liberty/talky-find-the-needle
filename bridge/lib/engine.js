// Workflow engine: templating, conditions, and expansion of a workflow into
// the flat list of game steps the mod executes.

'use strict';

// ------------------------------------------------------------------ limits
// Applied by the bridge before a job reaches the game (the mod applies the same caps).
const LIMITS = {
  waitSeconds: 600,      // longest "wait" step
  textLength: 200,       // notify / say / halo text
  notifySeconds: 60,     // longest on-screen banner
  repeatMax: 100,        // hard ceiling of a "repeat" step, whatever its "max"
  gameStepsPerJob: 500,  // steps of one job after expansion; the rest is dropped
  bridgeStepsPerJob: 20, // http / log steps of one job; the rest is dropped
  // Steps and loop turns walked through to build one job. Past it the workflow stops, so
  // nested "repeat" steps cannot freeze the bridge (it is single-threaded).
  visitedStepsPerJob: 10000,
};

const TEXT_ACTIONS = new Set(['notify', 'say', 'halo']);

// Own keys only: "constructor" or "toString" are not filters or operators.
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// ------------------------------------------------------------------ numbers
// LibertyTalk sends every variable as a string ("500", "1000", "4.50").

// Strict parse: returns a number, or undefined when the value is not a plain number.
// Accepts "1 000" / "1,000" (thousands) and "4,50" (decimal comma).
function parseNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  let s = v.replace(/[\s  ]/g, '');
  if (s === '') return undefined;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// Lenient conversion used by filters and numeric operators: never NaN.
function toNum(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const strict = parseNumeric(v);
  if (strict !== undefined) return strict;
  const loose = parseFloat(typeof v === 'string' ? v.replace(/[\s  ]/g, '').replace(',', '.') : v);
  return Number.isFinite(loose) ? loose : 0;
}

// ------------------------------------------------------------------ templating
// "{{ path | filter:arg | filter }}": double braces, so they don't clash with
// LibertyTalk's own single-brace variables ({user_name}) as long as the templates
// stay in talky_config.json.

function lookup(vars, path) {
  if (path === '' || path === undefined) return undefined;
  let cur = vars;
  for (const key of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

const filters = {
  default: (v, d) => (v === undefined || v === null || v === '' ? d : v),
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  truncate: (v, n) => String(v ?? '').slice(0, toNum(n) || 20),
  number: (v) => toNum(v),
  round: (v) => Math.round(toNum(v)),
  floor: (v) => Math.floor(toNum(v)),
  ceil: (v) => Math.ceil(toNum(v)),
  add: (v, n) => toNum(v) + toNum(n),
  sub: (v, n) => toNum(v) - toNum(n),
  mul: (v, n) => toNum(v) * toNum(n),
  div: (v, n) => toNum(v) / (toNum(n) || 1),
  min: (v, n) => Math.min(toNum(v), toNum(n)),
  max: (v, n) => Math.max(toNum(v), toNum(n)),
  clamp: (v, lo, hi) => Math.min(toNum(hi), Math.max(toNum(lo), toNum(v))),
  // Twitch sub tiers come as 1000/2000/3000
  tier: (v) => Math.max(1, Math.round(toNum(v) / 1000)),
  pick: (_v, ...choices) => choices[Math.floor(Math.random() * choices.length)],
  json: (v) => JSON.stringify(v),
};

function evalExpr(expr, vars) {
  const [head, ...chain] = expr.split('|').map((s) => s.trim());
  // Literal strings: {{ 'text' | upper }}
  let value = /^'.*'$/.test(head) ? head.slice(1, -1) : lookup(vars, head);
  for (const f of chain) {
    const [name, ...args] = f.split(':').map((s) => s.trim());
    const fn = hasOwn(filters, name) ? filters[name] : undefined;
    if (!fn) throw new Error(`unknown filter "${name}"`);
    // default:other_var falls back to another variable when one exists with that name
    if (name === 'default' && args.length) args[0] = lookup(vars, args[0]) ?? args[0];
    value = fn(value, ...args);
  }
  return value;
}

const TOKEN = /\{\{([^}]+)\}\}/g;
const SINGLE = /^\{\{([^}]+)\}\}$/;

function render(value, vars) {
  if (typeof value === 'string') {
    // A string that is exactly one expression keeps the expression's type (numbers stay numbers).
    const single = value.match(SINGLE);
    if (single) return evalExpr(single[1], vars);
    return value.replace(TOKEN, (_, expr) => {
      const v = evalExpr(expr, vars);
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => render(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, vars);
    return out;
  }
  return value;
}

// ------------------------------------------------------------------ conditions
// { "bits": { "gte": 100 } }, { "tier": "3000" }, { "all": [...] }, { "any": [...] }, { "not": {...} }

const ops = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  gt: (a, b) => toNum(a) > toNum(b),
  gte: (a, b) => toNum(a) >= toNum(b),
  lt: (a, b) => toNum(a) < toNum(b),
  lte: (a, b) => toNum(a) <= toNum(b),
  in: (a, b) => (Array.isArray(b) ? b : [b]).map(String).includes(String(a)),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()),
  matches: (a, b) => new RegExp(b, 'i').test(String(a ?? '')),
  exists: (a, b) => (a !== undefined && a !== null && a !== '') === Boolean(b),
};

function test(cond, vars) {
  if (cond === undefined || cond === null) return true;
  if (Array.isArray(cond)) return cond.every((c) => test(c, vars));
  if (cond.all) return arr(cond.all).every((c) => test(c, vars));
  if (cond.any) return arr(cond.any).some((c) => test(c, vars));
  if (cond.not) return !test(cond.not, vars);
  return Object.entries(cond).every(([path, expected]) => {
    const actual = lookup(vars, path);
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
      return Array.isArray(expected) ? ops.in(actual, expected) : ops.eq(actual, expected);
    }
    return Object.entries(expected).every(([op, b]) => {
      if (!hasOwn(ops, op)) throw new Error(`unknown operator "${op}"`);
      return ops[op](actual, b);
    });
  });
}

// ------------------------------------------------------------------ expansion

// The game writes JSON with Kahlua, where an empty list comes out as {} and lists
// may come back as objects: accept both.
function arr(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.keys(v).sort((a, b) => a - b).map((k) => v[k]);
  return v === undefined || v === null ? [] : [v];
}

// Actions executed by the bridge itself instead of the game.
const BRIDGE_ACTIONS = new Set(['http', 'log']);

function pickWeighted(branches, weights) {
  const w = branches.map((_, i) => toNum(weights?.[i] ?? 1));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < branches.length; i++) {
    r -= w[i];
    if (r <= 0) return branches[i];
  }
  return branches[branches.length - 1];
}

// Cuts a text to LIMITS.textLength characters (code points, so emojis are not split).
function clipText(v) {
  const chars = Array.from(String(v ?? ''));
  return chars.length > LIMITS.textLength ? chars.slice(0, LIMITS.textLength).join('') : chars.join('');
}

// Caps applied to a rendered game step, whatever the workflow asks for.
function capGameStep(step) {
  if (step.action === 'wait' && step.seconds !== undefined) {
    step.seconds = Math.min(Math.max(toNum(step.seconds), 0), LIMITS.waitSeconds);
  }
  if (TEXT_ACTIONS.has(step.action) && step.text !== undefined && step.text !== null) {
    step.text = clipText(step.text);
  }
  if (step.action === 'notify' && step.seconds !== undefined) {
    step.seconds = Math.min(Math.max(toNum(step.seconds), 1), LIMITS.notifySeconds);
  }
  return step;
}

// Counts one step or one loop turn. Returns false once the walk must stop: the visit budget
// is spent, or the game and bridge lists are both full (nothing more can be added).
function visit(out) {
  if (out.truncated) return false;
  out.visited += 1;
  const full = out.game.length >= LIMITS.gameStepsPerJob && out.bridge.length >= LIMITS.bridgeStepsPerJob;
  if (out.visited > LIMITS.visitedStepsPerJob || full) {
    out.truncated = true;
    return false;
  }
  return true;
}

// Turns control-flow steps (if / random / repeat / set) into a flat list.
// Returns { game: [...steps for the mod], bridge: [...side effects], dropped: n,
// visited: n, truncated: true when the walk stopped before the end of the workflow }.
// "dropped" counts the actions met once their list was full, not the ones never reached.
function expand(steps, vars, out = { game: [], bridge: [], dropped: 0, visited: 0, truncated: false }, depth = 0) {
  if (depth > 20) throw new Error('workflow nesting too deep');
  for (const step of arr(steps)) {
    if (!visit(out)) return out;
    if (!step || typeof step !== 'object') throw new Error(`step without action: ${JSON.stringify(step)}`);
    if (step.if !== undefined) {
      expand(test(step.if, vars) ? step.then : step.else, vars, out, depth + 1);
    } else if (step.random) {
      expand(pickWeighted(arr(step.random), arr(step.weights)), vars, out, depth + 1);
    } else if (step.repeat !== undefined) {
      const max = Math.min(toNum(step.max ?? 50), LIMITS.repeatMax);
      const n = Math.min(Math.floor(toNum(render(step.repeat, vars))), max);
      for (let i = 1; i <= n; i++) {
        if (!visit(out)) return out;
        expand(step.steps, { ...vars, i }, out, depth + 1);
      }
    } else if (step.set) {
      Object.assign(vars, render(step.set, vars));
    } else if (step.chance !== undefined && !step.action) {
      if (Math.random() < toNum(step.chance)) expand(step.steps, vars, out, depth + 1);
    } else if (step.action) {
      // A step whose list is full is counted without being rendered.
      if (BRIDGE_ACTIONS.has(step.action)) {
        if (out.bridge.length < LIMITS.bridgeStepsPerJob) out.bridge.push(render(step, vars));
        else out.dropped += 1;
      } else if (out.game.length < LIMITS.gameStepsPerJob) {
        out.game.push(capGameStep(render(step, vars)));
      } else {
        out.dropped += 1;
      }
    } else {
      throw new Error(`step without action: ${JSON.stringify(step)}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ vars

// Field names LibertyTalk triggers use for "who did it", across networks.
const USER_FIELDS = [
  'user', 'user_name', 'author_display_name', 'display_name', 'donor', 'chatter_name',
  'actor_name', 'username', 'author_username', 'user_login', 'name',
];

// Fields LibertyTalk sends as strings that workflows compare or compute as numbers.
const NUMERIC_FIELDS = ['bits', 'viewers', 'total', 'amount', 'tier'];

const DEFAULT_ANONYMOUS = 'Anonymous';

// opts.anonymousName: name used when the payload names nobody (anonymous cheer...).
function buildVars(payload, extra = {}, opts = {}) {
  const vars = { ...(payload && typeof payload === 'object' ? payload : { raw: payload }), ...extra };
  vars.payload = payload;
  for (const f of NUMERIC_FIELDS) {
    const n = parseNumeric(vars[f]);
    if (n !== undefined) vars[f] = n;
  }
  if (typeof vars.user !== 'string' || vars.user === '') {
    const found = USER_FIELDS.map((f) => vars[f]).find((v) => typeof v === 'string' && v.trim() !== '');
    vars.user = found || opts.anonymousName || DEFAULT_ANONYMOUS;
  }
  vars.now = new Date().toISOString();
  return vars;
}

module.exports = {
  render, test, expand, buildVars, lookup, filters, arr,
  toNum, parseNumeric, capGameStep, clipText,
  LIMITS, NUMERIC_FIELDS, BRIDGE_ACTIONS,
};
