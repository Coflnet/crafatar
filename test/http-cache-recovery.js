// Whole-app regression with dedicated localhost Redis and no upstream traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const redis = require('redis');
const { createCanvas, loadImage } = require('canvas');

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:16380' + url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP timeout')));
  });
}

(async function() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crafatar-http-'));
  const children = [];
  let client;
  let logs = '';
  const timeout = setTimeout(() => {
    console.error('Whole-app HTTP test exceeded 20 seconds');
    process.exitCode = 1;
    if (client) client.end(true);
    for (const child of children) child.kill('SIGKILL');
  }, 20000);
  function start(command, args, options) {
    const child = spawn(command, args, options);
    children.push(child);
    child.on('error', err => { logs += err.message; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-4000); });
    return child;
  }
  try {
    // These ports and processes exist only inside the isolated Docker test stage.
    start('redis-server', ['--bind', '127.0.0.1', '--port', '16379', '--save', '', '--appendonly', 'no', '--dir', dir]);
    client = redis.createClient('redis://127.0.0.1:16379');
    client.on('error', () => {});
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Test Redis startup timed out')), 5000);
      client.once('ready', () => { clearTimeout(deadline); resolve(); });
    });
    const set = promisify(client.set).bind(client);
    const get = promisify(client.get).bind(client);
    const hset = promisify(client.hset).bind(client);
    const hget = promisify(client.hget).bind(client);
    const uuid = '0098cb60fa8e427cb299793cbd302c9a';
    const hash = 'a'.repeat(64);
    await set('unrelated:sentinel', 'preserved');
    await hset(uuid, 's', hash, 'c', '', 'a', '1', 't', String(Date.now()));
    const env = { ...process.env, REDIS_URL: 'redis://127.0.0.1:16379', PORT: '16380', EPHEMERAL_STORAGE: 'true' };
    for (const [name, variable] of [['skins', 'SKIN_DIR'], ['faces', 'FACE_DIR'], ['helms', 'HELM_DIR'], ['renders', 'RENDER_DIR'], ['capes', 'CAPE_DIR']]) {
      const imageDir = path.join(dir, name);
      await fs.mkdir(imageDir);
      env[variable] = imageDir + '/';
    }
    const skin = createCanvas(64, 64), ctx = skin.getContext('2d');
    ctx.fillStyle = 'red'; ctx.fillRect(8, 8, 8, 8);
    ctx.fillStyle = 'blue'; ctx.fillRect(40, 8, 4, 8);
    await fs.writeFile(path.join(dir, 'skins', hash + '.png'), skin.toBuffer());
    const app = start(process.execPath, ['www.js'], { env });
    let ready = false;
    for (let attempt = 0; attempt < 50 && app.exitCode === null; attempt++) {
      try { if ((await request('/')).status === 200) { ready = true; break; } } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'Application did not become HTTP ready');
    const results = await Promise.all(Array.from({ length: 32 }, () => request('/avatars/' + uuid + '?overlay&size=32')));
    for (const result of results) {
      assert.equal(result.status, 200);
      assert.equal(result.type, 'image/png');
      const decoded = await loadImage(result.body);
      assert.equal(decoded.width, 32); assert.equal(decoded.height, 32);
      const output = createCanvas(32, 32).getContext('2d'); output.drawImage(decoded, 0, 0);
      assert.deepEqual([...output.getImageData(0, 0, 1, 1).data], [0, 0, 255, 255]);
      assert.deepEqual([...output.getImageData(31, 0, 1, 1).data], [255, 0, 0, 255]);
      assert.deepEqual(result.body, results[0].body);
    }
    const rendered = await request('/renders/body/' + uuid + '?slim=1');
    assert.equal(rendered.status, 200); assert.equal(rendered.type, 'image/png');
    const decoded = await loadImage(rendered.body);
    assert.equal(decoded.width, 120); assert.equal(decoded.height, 270);
    assert.equal(await get('unrelated:sentinel'), 'preserved');
    assert.equal(await hget(uuid, 's'), hash);
    assert.equal(await hget(uuid, 'a'), '1');
    console.log('Whole-app HTTP checks passed: 32 concurrent accurate avatars, slim render, Redis metadata and sentinel preserved');
  } catch (err) {
    console.error(logs);
    throw err;
  } finally {
    clearTimeout(timeout);
    if (client) client.end(true);
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', resolve);
      child.kill('SIGKILL');
    })));
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
