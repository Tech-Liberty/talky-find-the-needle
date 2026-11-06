'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { Bridge, parseBody } = require('../bridge');

const TOKEN = 'test-token-long-enough';

function config(overrides = {}) {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  return { ...example, port: 0, gamePort: 0, token: TOKEN, ...overrides };
}

// Plays the mod's side of the TCP link.
class FakeGame {
  constructor(port) {
    this.messages = [];
    this.catalogs = [];
    this.waiters = [];
    let buffer = '';
    this.sock = net.connect(port, '127.0.0.1');
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buffer.slice(0, end));
        (msg.t === 'catalog' ? this.catalogs : this.messages).push(msg);
        buffer = buffer.slice(end + 1);
        this.waiters.splice(0).forEach((w) => w());
      }
    });
    this.ready = new Promise((resolve) => this.sock.once('connect', resolve));
  }

  send(msg) {
    this.sock.write(`${JSON.stringify(msg)}\n`);
  }

  async nextJob(index = 0) {
    while (this.messages.length <= index) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no job received')), 2000);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages[index];
  }

  close() {
    this.sock.destroy();
  }
}

async function setup(t, overrides) {
  const logs = [];
  const bridge = new Bridge(config(overrides), { logger: (m) => logs.push(m) });
  const ports = await bridge.start();
  t.after(() => bridge.stop());
  const post = (route, body, token = TOKEN) => fetch(`http://127.0.0.1:${ports.http}${route}`, {
    method: 'POST',
    headers: { 'x-bridge-token': token },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  });
  const connectGame = async (inWorld = true) => {
    const game = new FakeGame(ports.game);
    t.after(() => game.close());
    await game.ready;
    game.send({ t: 'hello', protocol: 1, version: 'test' });
    game.send({ t: 'state', inWorld });
    return game;
  };
  return { bridge, ports, post, connectGame, logs };
}

test('webhooks and unknown ids answer 401 without a valid token', async (t) => {
  const { post } = await setup(t);
  assert.strictEqual((await post('/hooks/follow', {}, 'wrong')).status, 401);
  assert.strictEqual((await post('/hooks/does-not-exist', {}, 'wrong')).status, 401);
  assert.strictEqual((await post('/hooks/does-not-exist')).status, 404);
});

test('a follow reaches the game with the rendered steps', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  const res = await post('/hooks/follow', { user_name: 'Bob' });
  assert.strictEqual(res.status, 200);
  const job = await game.nextJob();
  assert.strictEqual(job.t, 'job');
  assert.strictEqual(job.user, 'Bob');
  assert.match(job.steps[0].text, /Bob/);
  assert.strictEqual(job.steps[1].action, 'duck');
  assert.strictEqual(job.steps[1].name, 'Bob');
});

test('numbers sent as text are computed and capped by the workflow', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  await post('/hooks/raid', { user_name: 'R', viewers: '5000' });
  const job = await game.nextJob();
  assert.strictEqual(job.steps[1].count, 300);
});

test('points are routed on the reward title, and no match runs nothing', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  const none = await (await post('/hooks/points', { user_name: 'A', reward_title: 'Hydrate-toi' })).json();
  assert.deepStrictEqual(none.results, []);
  await post('/hooks/points', { user_name: 'A', reward_title: 'Gust of WIND' });
  const job = await game.nextJob();
  assert.strictEqual(job.workflow, 'points_gust');
});

test('jobs wait for a loaded world, and the ack removes them', async (t) => {
  const { bridge, post, connectGame } = await setup(t);
  const game = await connectGame(false);
  await post('/hooks/follow', { user_name: 'Bob' });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(game.messages.length, 0);
  game.send({ t: 'state', inWorld: true });
  const job = await game.nextJob();
  assert.strictEqual(bridge.pending.size, 1);
  game.send({ t: 'ack', seq: job.seq });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(bridge.pending.size, 0);
});

test('an unacknowledged job is sent again after a reconnection', async (t) => {
  const { post, connectGame } = await setup(t);
  const first = await connectGame();
  await post('/hooks/follow', { user_name: 'Bob' });
  const job = await first.nextJob();
  first.close();
  await new Promise((r) => setTimeout(r, 50));
  const second = await connectGame();
  const again = await second.nextJob();
  assert.strictEqual(again.seq, job.seq);
});

test('waiting jobs expire', async (t) => {
  const { bridge, post, connectGame } = await setup(t, { jobTtlSeconds: 1 });
  await post('/hooks/follow', { user_name: 'Bob' });
  assert.strictEqual(bridge.pending.size, 1);
  await new Promise((r) => setTimeout(r, 1100));
  const game = await connectGame();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(bridge.pending.size, 0);
  assert.strictEqual(game.messages.length, 0);
});

test('cooldowns and the per-minute ceiling stop viewers', async (t) => {
  const { post } = await setup(t, {
    settings: { maxJobsPerMinute: 2 },
    webhooks: { a: { workflow: 'one' }, b: { workflow: 'two' }, c: { workflow: 'three' } },
    workflows: {
      one: { cooldownSeconds: 60, steps: [{ action: 'notify', text: 'x' }] },
      two: { steps: [{ action: 'notify', text: 'x' }] },
      three: { steps: [{ action: 'notify', text: 'x' }] },
    },
  });
  const reason = async (hook) => (await (await post(`/hooks/${hook}`)).json()).results[0].reason;
  assert.strictEqual(await reason('a'), undefined);
  assert.strictEqual(await reason('a'), 'cooldown');
  assert.strictEqual(await reason('b'), undefined);
  assert.strictEqual(await reason('c'), 'rate_limit');
});

test('safe mode removes the blocked actions only', async (t) => {
  const { post, connectGame } = await setup(t, {
    settings: { safeMode: true, safeModeBlocks: ['yeet'] },
  });
  const game = await connectGame();
  await post('/fire/points_yeet', { user_name: 'A' });
  const job = await game.nextJob();
  assert.deepStrictEqual(job.steps.map((s) => s.action), ['notify']);
});

test('a manual fire ignores the cooldown of the workflow', async (t) => {
  const { post } = await setup(t);
  for (let i = 0; i < 2; i++) {
    const body = await (await post('/fire/points_yeet', { user_name: 'A' })).json();
    assert.strictEqual(body.ok, true);
  }
});

test('a message webhook reaches the game with its author and text', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  await post('/hooks/message', { user_name: 'Bob', text: 'Salut {{token}}' });
  const job = await game.nextJob();
  assert.deepStrictEqual(job.steps[0], { action: 'message', author: 'Bob', text: 'Salut {{token}}' });
});

test('a message can also come in a "message" field', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  await post('/hooks/message', { user_name: 'Bob', message: 'Coucou' });
  const job = await game.nextJob();
  assert.strictEqual(job.steps[0].text, 'Coucou');
});

const settle = () => new Promise((r) => setTimeout(r, 50));

test('the game receives the menu catalog when it connects', async (t) => {
  const { connectGame } = await setup(t);
  const game = await connectGame();
  await settle();
  const ids = game.catalogs[0].workflows.map((w) => w.id);
  assert.ok(ids.includes('points_duck'));
  assert.ok(!ids.includes('on_needle_found'));
  assert.ok(!JSON.stringify(game.catalogs[0]).includes(TOKEN));
});

test('the menu can only start workflows it offers, with their test values', async (t) => {
  const { connectGame, logs } = await setup(t);
  const game = await connectGame();
  game.send({ t: 'fire', workflow: 'on_needle_found', user: 'Bob' });
  game.send({ t: 'fire', workflow: 'report_to_libertytalk', user: 'Bob' });
  await settle();
  assert.strictEqual(game.messages.length, 0);
  assert.strictEqual(logs.filter((l) => l.includes('not in the menu')).length, 2);
  game.send({ t: 'fire', workflow: 'raid', user: 'Bob' });
  const job = await game.nextJob();
  assert.strictEqual(job.user, 'Bob');
  assert.strictEqual(job.steps[1].count, 250);
});

test('pausing the viewers stops webhooks, not the menu, and answers with a new catalog', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  game.send({ t: 'settings', paused: true, safeMode: false });
  await settle();
  assert.strictEqual(game.catalogs.at(-1).paused, true);
  const body = await (await post('/hooks/follow', { user_name: 'Bob' })).json();
  assert.strictEqual(body.results[0].reason, 'paused');
  game.send({ t: 'fire', workflow: 'points_duck', user: 'Bob' });
  assert.strictEqual((await game.nextJob()).workflow, 'points_duck');
});

test('bits are multiplied, capped by the workflow, and the multiplier can change from the menu', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  await post('/hooks/bits', { user_name: 'Bob', bits: '500' });
  const first = await game.nextJob(0);
  assert.strictEqual(first.steps.find((s) => s.action === 'hay_rain').count, 5000);
  game.send({ t: 'settings', bitsMultiplier: 2 });
  await settle();
  assert.strictEqual(game.catalogs.at(-1).bitsMultiplier, 2);
  await post('/hooks/bits', { user_name: 'Bob', bits: '500' });
  const second = await game.nextJob(1);
  assert.strictEqual(second.steps.find((s) => s.action === 'hay_rain').count, 1000);
  await post('/hooks/bits', { user_name: 'Bob', bits: '100000' });
  const third = await game.nextJob(2);
  assert.strictEqual(third.steps.find((s) => s.action === 'hay_rain').count, 5000);
});

test('every example text has its French version, and French rewards are routed', async (t) => {
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  const overlay = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'examples.fr.json'), 'utf8'));
  const { localizeExamples, resolvePath } = require('../lib/examples');
  const { systemLanguage } = require('../bridge');
  for (const dot of Object.keys(overlay).filter((k) => !k.startsWith('_'))) {
    const found = resolvePath(example, dot);
    assert.ok(found, `missing path ${dot}`);
    assert.strictEqual(found[0][found[1]], overlay[dot].en, dot);
  }
  const texts = [];
  JSON.stringify(example.workflows, (key, value) => {
    if ((key === 'text' || key === 'label') && typeof value === 'string') texts.push(value);
    return value;
  });
  const covered = new Set(Object.values(overlay).map((e) => e.en));
  assert.deepStrictEqual(texts.filter((v) => !covered.has(v) && !/^\{\{[^}]*\}\}$/.test(v)), []);
  const french = JSON.parse(JSON.stringify(example));
  assert.strictEqual(localizeExamples(french, 'fr', overlay), Object.keys(overlay).length - 1);
  assert.strictEqual(french.settings.anonymousName, 'Anonyme');
  assert.strictEqual(systemLanguage('fr-FR'), 'fr');
  assert.strictEqual(systemLanguage('de-DE'), 'en');
  const { post, connectGame } = await setup(t, { webhooks: french.webhooks, workflows: french.workflows });
  const game = await connectGame();
  await post('/hooks/points', { user_name: 'A', reward_title: 'Coup de VENT' });
  assert.strictEqual((await game.nextJob()).workflow, 'points_gust');
});

test('the example config only uses actions the mod has', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'mods', 'talky_needle', 'tn_actions.gd'), 'utf8');
  const known = new Set([...source.matchAll(/register\("(\w+)"/g)].map((m) => m[1]));
  known.add('wait').add('log').add('http');
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  const used = JSON.stringify(example.workflows).matchAll(/"action":"(\w+)"/g);
  for (const [, action] of used) assert.ok(known.has(action), `unknown action ${action}`);
});

test('the fake needle workflow expands to a growing series of beeps', async (t) => {
  const { post, connectGame } = await setup(t);
  const game = await connectGame();
  await post('/fire/points_fake_needle', { user_name: 'A' });
  const job = await game.nextJob();
  assert.strictEqual(job.steps.filter((s) => s.name === 'beep').length, 12);
  assert.match(job.steps.at(-1).text, /Thanks A/);
});

test('a game event runs its workflow; an unfilled http target is refused without a request', async (t) => {
  const { connectGame, logs, bridge } = await setup(t);
  bridge.cfg.workflows.report_to_libertytalk.enabled = true;
  const game = await connectGame();
  game.send({ t: 'event', event: 'needle_found', data: { index: 3, needlesFound: 1 } });
  const job = await game.nextJob();
  assert.strictEqual(job.workflow, 'on_needle_found');
  assert.ok(logs.some((l) => l.includes('lt_report') && l.includes('not filled in')));
  assert.ok(!logs.join('\n').includes('PASTE_'));
});

test('an http target outside the allowed hosts is refused', async (t) => {
  const { bridge, logs } = await setup(t, {
    httpTargets: { evil: { url: 'https://example.org/x' } },
  });
  await bridge.runBridgeStep({ action: 'http', target: 'evil' }, 'w');
  assert.ok(logs.some((l) => l.includes('httpAllowedHosts')));
});

test('missing hooks are reported', async (t) => {
  const { connectGame, logs } = await setup(t);
  const game = await connectGame();
  game.send({ t: 'compat', hooks: { 'live.spawn': false, 'hud.show_toast': true } });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(logs.some((l) => l.includes('live.spawn') && !l.includes('hud.show_toast')));
});

test('the token never appears in the logs', async (t) => {
  const { post, connectGame, logs } = await setup(t);
  const game = await connectGame();
  await post('/hooks/follow', { user_name: 'Bob' });
  await game.nextJob();
  assert.ok(!logs.join('\n').includes(TOKEN));
});

test('a body with an unescaped quote is recovered', () => {
  assert.deepStrictEqual(parseBody('{"user_name":"Bo"b","bits":"5"}'), { user_name: 'Bo"b', bits: '5' });
});
