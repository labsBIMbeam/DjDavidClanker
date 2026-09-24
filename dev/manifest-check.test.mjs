import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'vite';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const [variant, config] of [['desktop', 'vite.config.js'], ['totem', 'vite.totem.config.js'],
  ['synth', 'vite.synth.config.js']]) {
  test(`${variant} emits a complete manifest in the requested output directory`, async () => {
    const outDir = resolve('.qa', variant);
    await mkdir(outDir, { recursive: true });
    await build({ configFile: resolve(config), logLevel: 'error', build: { outDir } });
    const manifest = JSON.parse(await readFile(resolve(outDir, '.nip5a-manifest.json'), 'utf8'));
    const html = await readFile(resolve(outDir, 'index.html'));
    const tags = (key) => manifest.tags.filter((tag) => tag[0] === key);
    assert.equal(manifest.kind, 35129);
    assert.deepEqual(tags('archetype'), variant === 'synth' ? []
      : [['archetype', 'music', 'napplet:music/open']]);
    assert.deepEqual(tags('path'), [['path', '/index.html', sha(html)]]);
    assert.deepEqual(tags('x'), [['x', sha(`${sha(html)} /index.html\n`), 'aggregate']]);
    for (const key of ['title', 'description', 'source']) assert.equal(tags(key).length, 1);
    assert.ok(tags('server').length > 0);
    if (variant === 'synth') assert.deepEqual(tags('requires'), []);
    else assert.ok(tags('requires').some((tag) => tag[1] === 'inc'));
    assert.ok(!tags('requires').some((tag) => tag[1] === 'common'));
    assert.ok(!html.toString().includes('napplet:dj/open'));
  });
}
