#!/usr/bin/env node
// Talky Needle bridge: LibertyTalk webhooks -> Find The Needle.
//
//   LibertyTalk --HTTPS--> tunnel --> POST /hooks/<id> (127.0.0.1:7421)
//                                       | workflows (lib/engine.js, shared with Talky)
//   mod in the game  <--JSON lines over TCP--> 127.0.0.1:7422
//
// Same webhook contract as Talky (/hooks/<id>, X-Bridge-Token). Unlike Project Zomboid's
// Lua, GDScript can open a socket, so the game link is a local TCP connection, not files.
//
//   node bridge.js                                 start
//   node bridge.js fire <workflow> [key=value...]  run a workflow on the running bridge

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { expand, test, buildVars, arr, toNum } = require('./lib/engine');
const { checkHttpUrl } = require('./lib/hosts');

const VERSION = require('./package.json').version;
const PROTOCOL = 1;
const CONFIG_PATH = process.env.TN_BRIDGE_CONFIG || path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');
const PLACEHOLDER_TOKEN = 'change-me-to-a-long-random-string';
const MAX_BODY = 65536;
const MAX_GAME_LINE = 1048576;
const MAX_PENDING_JOBS = 200;
const MAX_JOB_TTL_SECONDS = 900;
const HTTP_STEP_TIMEOUT_MS = 10000;
const SWEEP_MS = 5000;
const MAX_BITS_MULTIPLIER = 100;
const NAME_RE = /^[\w.-]{1,64}$/;

const log = (msg) => console.log(`${new Date().toLocaleTimeString()} ${msg}`);

// ------------------------------------------------------------------ helpers

// LibertyTalk inserts variables into the JSON body without escaping them, so a text
// containing a quote produces invalid JSON. Recover "key": value pairs anyway.
function parseBody(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch { /* fall through */ }
  const out = {};
  const re = /"([\w.-]+)"\s*:\s*(?:"([\s\S]*?)"(?=\s*(?:,\s*"[\w.-]+"\s*:|\}\s*$))|(-?\d+(?:\.\d+)?|true|false|null))/g;
  let m;
  while ((m = re.exec(raw))) out[m[1]] = m[2] !== undefined ? m[2] : JSON.parse(m[3]);
  return Object.keys(out).length ? out : { raw };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------ bridge

class Bridge {
  constructor(cfg, { logger = log } = {}) {
    this.cfg = cfg;
    this.log = logger;
    this.settings = cfg.settings ?? {};
    this.ttlMs = Math.min(Math.max(toNum(cfg.jobTtlSeconds ?? MAX_JOB_TTL_SECONDS), 1), MAX_JOB_TTL_SECONDS) * 1000;
    this.seq = Date.now(); // keeps growing across restarts: the mod ignores seqs it has seen
    this.pending = new Map(); // seq -> job, in order, until the mod acknowledges it
    this.sentOnThisLink = new Set();
    this.game = null;
    this.gameState = { inWorld: false };
    this.lastRun = new Map(); // workflow -> time of its last run
    this.lastRunByUser = new Map(); // workflow + user -> time of its last run
    this.recentHookJobs = []; // times of the jobs started by webhooks in the last minute
  }

  // ---------------------------------------------------------------- start / stop
  async start() {
    this.httpServer = http.createServer((req, res) => this.onRequest(req, res));
    this.gameServer = net.createServer((sock) => this.onGameConnection(sock));
    await this.listen(this.httpServer, this.cfg.port);
    await this.listen(this.gameServer, this.cfg.gamePort);
    this.sweeper = setInterval(() => this.pump(), SWEEP_MS);
    this.sweeper.unref();
    return { http: this.httpServer.address().port, game: this.gameServer.address().port };
  }

  listen(server, port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async stop() {
    clearInterval(this.sweeper);
    this.game?.destroy();
    this.httpServer?.closeAllConnections?.();
    await Promise.all([this.httpServer, this.gameServer].map((s) => new Promise((r) => s.close(r))));
  }

  // ---------------------------------------------------------------- workflows
  // Returns { ok: true, seq?, steps } or { ok: false, reason }. source: hook | fire | game.
  runWorkflow(name, payload, source) {
    const wf = this.cfg.workflows?.[name];
    if (!wf || typeof wf !== 'object') {
      this.log(`warning: unknown workflow "${name}"`);
      return { ok: false, reason: 'unknown_workflow' };
    }
    if (wf.enabled === false) return { ok: false, reason: 'disabled' };
    const vars = buildVars(payload, { workflow: name, source, gameState: this.gameState }, {
      anonymousName: this.settings.anonymousName,
    });
    if (typeof vars.bits === 'number') vars.bitsMultiplied = Math.round(vars.bits * this.bitsMultiplier());
    let out;
    try {
      if (!test(wf.when, vars)) return { ok: false, reason: 'condition' };
      if (wf.chance !== undefined && Math.random() >= toNum(wf.chance)) return { ok: false, reason: 'chance' };
      const blocked = this.checkLimits(name, wf, vars.user, source);
      if (blocked) return { ok: false, reason: blocked };
      out = expand(wf.steps, vars);
    } catch (e) {
      this.log(`warning: workflow "${name}": ${e.message}`);
      return { ok: false, reason: 'workflow_error' };
    }
    if (out.truncated || out.dropped) this.log(`warning: workflow "${name}" was cut: too many steps`);
    for (const step of out.bridge) this.runBridgeStep(step, name);
    const steps = out.game.filter((s) => !this.isBlockedAction(s.action));
    if (!steps.length) return { ok: true, steps: 0 };
    const seq = this.enqueue({ workflow: name, user: vars.user, steps });
    return { ok: true, seq, steps: steps.length };
  }

  // Anti-grief: cooldowns of the workflow, and a ceiling on what viewers can start per minute.
  checkLimits(name, wf, user, source) {
    if (source === 'fire') return null; // a manual test always runs
    if (source === 'hook' && this.settings.paused === true) return 'paused';
    const now = Date.now();
    const cd = toNum(wf.cooldownSeconds) * 1000;
    if (cd > 0 && now - (this.lastRun.get(name) ?? 0) < cd) return 'cooldown';
    const userKey = `${name}\n${user}`;
    const userCd = toNum(wf.userCooldownSeconds) * 1000;
    if (userCd > 0 && now - (this.lastRunByUser.get(userKey) ?? 0) < userCd) return 'user_cooldown';
    if (source === 'hook') {
      this.recentHookJobs = this.recentHookJobs.filter((t) => now - t < 60000);
      const ceiling = toNum(this.settings.maxJobsPerMinute);
      if (ceiling > 0 && this.recentHookJobs.length >= ceiling) return 'rate_limit';
      this.recentHookJobs.push(now);
    }
    this.lastRun.set(name, now);
    if (userCd > 0) {
      if (this.lastRunByUser.size > 5000) this.lastRunByUser.clear();
      this.lastRunByUser.set(userKey, now);
    }
    return null;
  }

  // 500 bits with a multiplier of 10 give bitsMultiplied = 5000, for the workflows to use.
  bitsMultiplier() {
    const n = toNum(this.settings.bitsMultiplier ?? 1);
    return n > 0 ? Math.min(n, MAX_BITS_MULTIPLIER) : 1;
  }

  isBlockedAction(action) {
    if (arr(this.settings.blockedActions).includes(action)) return true;
    return this.settings.safeMode === true && arr(this.settings.safeModeBlocks).includes(action);
  }

  async runBridgeStep(step, workflow) {
    if (step.action === 'log') {
      this.log(`[${workflow}] ${step.message ?? ''}`);
      return;
    }
    // Only named targets: their URL and secret stay in config.json, out of the logs.
    const target = this.cfg.httpTargets?.[step.target];
    if (!target) return this.log(`warning: [${workflow}] unknown http target "${step.target}"`);
    if (JSON.stringify(target).includes('PASTE_')) {
      return this.log(`warning: [${workflow}] http target "${step.target}" is not filled in (config.json)`);
    }
    const check = checkHttpUrl(target.url, this.cfg.httpAllowedHosts);
    if (!check.ok) return this.log(`warning: [${workflow}] http target "${step.target}": ${check.reason}`);
    try {
      const res = await fetch(check.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...target.headers },
        body: JSON.stringify(step.body ?? {}),
        redirect: 'error',
        signal: AbortSignal.timeout(HTTP_STEP_TIMEOUT_MS),
      });
      this.log(`[${workflow}] http target "${step.target}": ${res.status}`);
    } catch (e) {
      this.log(`warning: [${workflow}] http target "${step.target}" failed: ${e.name}`);
    }
  }

  // ---------------------------------------------------------------- jobs
  enqueue({ workflow, user, steps }) {
    const seq = ++this.seq;
    this.pending.set(seq, { t: 'job', seq, workflow, user, steps, expires: Date.now() + this.ttlMs });
    if (this.pending.size > MAX_PENDING_JOBS) {
      const oldest = this.pending.keys().next().value;
      this.log(`warning: too many waiting jobs, dropping "${this.pending.get(oldest).workflow}"`);
      this.pending.delete(oldest);
    }
    this.pump();
    return seq;
  }

  // Sends what the game can run now. Waiting jobs expire: a game started late does not
  // receive 40 hay deliveries at once.
  pump() {
    const now = Date.now();
    for (const [seq, job] of this.pending) {
      if (job.expires <= now) {
        this.log(`job ${job.workflow} expired before the game could run it`);
        this.pending.delete(seq);
      }
    }
    if (!this.game || !this.gameState.inWorld) return;
    for (const [seq, job] of this.pending) {
      if (this.sentOnThisLink.has(seq)) continue;
      this.sentOnThisLink.add(seq);
      this.game.write(`${JSON.stringify(job)}\n`);
    }
  }

  // ---------------------------------------------------------------- game link
  onGameConnection(sock) {
    if (this.game) this.game.destroy(); // the game restarted: the newest connection wins
    this.game = sock;
    this.sentOnThisLink = new Set();
    this.gameState = { inWorld: false };
    sock.setNoDelay(true);
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_GAME_LINE) return sock.destroy();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        this.onGameLine(line);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.game !== sock) return;
      this.game = null;
      this.gameState = { inWorld: false };
      this.log('game disconnected');
    });
  }

  onGameLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        this.log(`game connected: mod v${msg.version}`);
        if (msg.protocol !== PROTOCOL) this.log(`warning: mod protocol ${msg.protocol}, bridge ${PROTOCOL}: update both`);
        this.sendCatalog();
        break;
      case 'fire':
        this.fireFromMenu(String(msg.workflow), msg.user);
        break;
      case 'settings':
        if (typeof msg.paused === 'boolean') this.settings.paused = msg.paused;
        if (typeof msg.safeMode === 'boolean') this.settings.safeMode = msg.safeMode;
        if (typeof msg.bitsMultiplier === 'number') this.settings.bitsMultiplier = msg.bitsMultiplier;
        this.log(`viewers ${this.settings.paused ? 'paused' : 'active'}, safe mode ${this.settings.safeMode ? 'on' : 'off'}, bits x${this.bitsMultiplier()} (until the bridge restarts)`);
        this.sendCatalog();
        break;
      case 'state':
        this.gameState = { inWorld: msg.inWorld === true, money: msg.money, needlesFound: msg.needlesFound };
        this.pump();
        break;
      case 'ack':
        this.pending.delete(Number(msg.seq));
        this.sentOnThisLink.delete(Number(msg.seq));
        break;
      case 'done':
        for (const f of arr(msg.failures)) this.log(`warning: job ${msg.seq}: ${f.action} failed: ${f.code}`);
        break;
      case 'compat':
        this.reportCompat(msg.hooks);
        break;
      case 'event':
        this.onGameEvent(String(msg.event), msg.data);
        break;
      default:
        break;
    }
  }

  // What the F8 window offers: the workflows that have a "menu" entry in config.json.
  sendCatalog() {
    if (!this.game) return;
    const workflows = Object.entries(this.cfg.workflows ?? {})
      .filter(([, wf]) => wf && wf.menu)
      .map(([id, wf]) => ({ id, label: String(wf.menu.label ?? id), group: String(wf.menu.group ?? '') }));
    this.game.write(`${JSON.stringify({
      t: 'catalog',
      workflows,
      paused: this.settings.paused === true,
      safeMode: this.settings.safeMode === true,
      bitsMultiplier: this.bitsMultiplier(),
    })}\n`);
  }

  // Only the workflows offered by the menu can be started from the game link.
  fireFromMenu(id, user) {
    const wf = Object.hasOwn(this.cfg.workflows ?? {}, id) ? this.cfg.workflows[id] : undefined;
    if (!wf || !wf.menu) return this.log(`warning: the game asked for "${id}", which is not in the menu`);
    const name = String(user ?? '').slice(0, 40).trim();
    return this.runWorkflow(id, { ...wf.menu.payload, ...(name ? { user: name } : {}) }, 'fire');
  }

  reportCompat(hooks) {
    if (!hooks || typeof hooks !== 'object') return;
    const missing = Object.entries(hooks).filter(([, v]) => v === false).map(([k]) => k);
    this.log(missing.length ? `warning: hooks missing in this game build: ${missing.join(', ')}` : 'all game hooks found');
    this.compat = hooks;
  }

  onGameEvent(event, data) {
    const names = arr(this.cfg.gameEvents?.[event]);
    this.log(`[game] ${event}${names.length ? ` -> ${names.join(', ')}` : ''}`);
    const payload = { ...(data && typeof data === 'object' ? data : {}), event };
    for (const name of names) this.runWorkflow(String(name), payload, 'game');
  }

  // ---------------------------------------------------------------- http
  authorized(req, url) {
    return safeEqual(req.headers['x-bridge-token'] ?? url.searchParams.get('token') ?? '', this.cfg.token);
  }

  hookWorkflows(hook, payload) {
    if (hook.routes) {
      const vars = buildVars(payload);
      const route = arr(hook.routes).find((r) => test(r.when, vars));
      return route ? arr(route.workflow) : [];
    }
    return arr(hook.workflow);
  }

  async onRequest(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://bridge');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { ok: true, version: VERSION, game: this.game !== null, inWorld: this.gameState.inWorld });
      }
      // Without a valid token every id answers 401, so webhook names cannot be guessed.
      if (!this.authorized(req, url)) return send(401, { error: 'unauthorized' });
      if (req.method !== 'POST' || parts.length !== 2 || !NAME_RE.test(parts[1])) return send(404, { error: 'not_found' });
      const [kind, id] = parts;
      if (kind === 'hooks') {
        const hook = Object.hasOwn(this.cfg.webhooks ?? {}, id) ? this.cfg.webhooks[id] : undefined;
        if (!hook) return send(404, { error: 'unknown_webhook' });
        const payload = parseBody(await readBody(req));
        const names = this.hookWorkflows(hook, payload);
        return send(200, { ok: true, results: names.map((n) => ({ workflow: n, ...this.runWorkflow(n, payload, 'hook') })) });
      }
      if (kind === 'fire') {
        const payload = parseBody(await readBody(req));
        return send(200, { workflow: id, ...this.runWorkflow(id, payload, 'fire') });
      }
      return send(404, { error: 'not_found' });
    } catch (e) {
      this.log(`warning: request failed: ${e.message}`);
      if (!res.headersSent) send(e.message === 'body too large' ? 413 : 400, { error: 'bad_request' });
    }
  }
}

// ------------------------------------------------------------------ config

// First start: config.json gets a random token, copied to the clipboard and never shown,
// so it stays off the stream.
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const token = crypto.randomBytes(24).toString('hex');
    const text = fs.readFileSync(EXAMPLE_PATH, 'utf8').replace(PLACEHOLDER_TOKEN, token);
    fs.writeFileSync(CONFIG_PATH, text, { flag: 'wx' });
    const copied = process.platform === 'win32' && spawnSync('clip', { input: token }).status === 0;
    log(`created config.json with a random token, ${copied ? 'copied to your clipboard' : 'see "token" in config.json'}; never shown here`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.token || cfg.token === PLACEHOLDER_TOKEN) throw new Error('set a real "token" in config.json');
  return cfg;
}

async function fireCli(cfg, workflow, args) {
  const body = Object.fromEntries(args.map((a) => {
    const at = a.indexOf('=');
    return at === -1 ? [a, true] : [a.slice(0, at), a.slice(at + 1)];
  }));
  const res = await fetch(`http://127.0.0.1:${cfg.port}/fire/${encodeURIComponent(workflow)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': cfg.token },
    body: JSON.stringify(body),
  });
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  if (command === 'fire') {
    if (!rest[0]) throw new Error('usage: node bridge.js fire <workflow> [key=value...]');
    return fireCli(cfg, rest[0], rest.slice(1));
  }
  if (command) throw new Error(`unknown command "${command}"`);
  const bridge = new Bridge(cfg);
  const ports = await bridge.start();
  log(`Talky Needle bridge ${VERSION} (unofficial): webhooks on http://127.0.0.1:${ports.http}, game link on port ${ports.game}`);
  log(`${Object.keys(cfg.webhooks ?? {}).length} webhook(s), ${Object.keys(cfg.workflows ?? {}).length} workflow(s), waiting for the game...`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { Bridge, parseBody, safeEqual, PROTOCOL };
