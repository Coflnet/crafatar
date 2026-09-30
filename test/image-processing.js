const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { createCanvas, loadImage } = require('canvas');
const skins = require('../lib/skins');
const renders = require('../lib/renders');
(async function() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crafatar-images-'));
  try {
    const skin = createCanvas(64, 64);
    const ctx = skin.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(8, 8, 8, 8);
    ctx.fillStyle = 'blue';
    ctx.fillRect(40, 8, 4, 8);
    const buffer = skin.toBuffer();
    const face = path.join(dir, 'face.png');
    const helm = path.join(dir, 'helm.png');
    await promisify(skins.extract_face)(buffer, face);
    await promisify(skins.extract_helm)('test', face, buffer, helm);
    const overlay = await loadImage(helm);
    const actual = createCanvas(8, 8).getContext('2d');
    actual.drawImage(overlay, 0, 0);
    assert.deepEqual([...actual.getImageData(0, 0, 1, 1).data], [0, 0, 255, 255]);
    assert.deepEqual([...actual.getImageData(7, 0, 1, 1).data], [255, 0, 0, 255]);
    const resized = await loadImage(await promisify(skins.resize_img)(helm, 32));
    assert.equal(resized.width, 32);
    assert.equal(resized.height, 32);
    ctx.clearRect(32, 0, 32, 32);
    await promisify(skins.extract_helm)('test', face, skin.toBuffer(), helm);
    assert.deepEqual(await fs.readFile(face), await fs.readFile(helm));
    ctx.fillStyle = 'green';
    ctx.fillRect(32, 0, 32, 32);
    await promisify(skins.extract_helm)('test', face, skin.toBuffer(), helm);
    assert.deepEqual(await fs.readFile(face), await fs.readFile(helm));
    for (const height of [32, 64]) for (const body of [false, true]) for (const slim of [false, true]) {
      const model = createCanvas(64, height);
      model.getContext('2d').drawImage(skin, 0, 0);
      const image = await loadImage(await promisify(renders.draw_model)('test', model.toBuffer(), 2, true, body, slim));
      assert.equal(image.width, 40);
      assert.equal(image.height, Math.floor(2 * (body ? 45.1 : 18.5)));
    }
    await assert.rejects(promisify(renders.draw_model)('test', Buffer.from('invalid'), 2, false, false, false));
    await assert.rejects(promisify(skins.save_image)(Buffer.from('invalid'), path.join(dir, 'bad.png')));
    console.log('Image extraction, overlay persistence, resize, render and invalid-image checks passed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
