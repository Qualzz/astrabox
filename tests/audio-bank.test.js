import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('assets/audio/catalog.json', root), 'utf8'));

test('audio bank contains a small, uniquely named selection with local provenance', async () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.sounds.length >= 12 && catalog.sounds.length <= 30);
  assert.equal(new Set(catalog.sounds.map(sound => sound.id)).size, catalog.sounds.length);
  assert.equal(new Set(catalog.sounds.map(sound => sound.file)).size, catalog.sounds.length);

  const sources = new Map(catalog.sources.map(source => [source.id, source]));
  for (const source of sources.values()) {
    assert.equal(source.license, 'CC0-1.0');
    assert.match(source.url, /^https:\/\//);
    assert.match(source.notice, /^\/assets\/audio\/[a-z-]+\/LICENSE\.txt$/);
    const license = await readFile(new URL(source.notice.slice(1), root), 'utf8');
    assert.match(license, /Creative Commons Zero, CC0/);
  }

  for (const sound of catalog.sounds) {
    assert.match(sound.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(sources.has(sound.source), `Unknown source for ${sound.id}`);
    assert.equal(sound.license, sources.get(sound.source).license);
    assert.ok(sound.tags.length && sound.tags.every(tag => typeof tag === 'string'));
    assert.ok(Number.isFinite(sound.duration) && sound.duration > 0 && sound.duration < 10);
  }
});

test('every catalog entry is an intact local Ogg Vorbis asset', async () => {
  let totalBytes = 0;
  for (const sound of catalog.sounds) {
    assert.match(sound.file, /^\/assets\/audio\/[a-z-]+\/[a-zA-Z0-9]+\.ogg$/);
    const data = await readFile(new URL(sound.file.slice(1), root));
    assert.equal(data.subarray(0, 4).toString('ascii'), 'OggS', sound.id);
    assert.ok(data.includes(Buffer.from('vorbis')), sound.id);
    assert.equal(data.length, sound.bytes, sound.id);
    assert.equal(createHash('sha256').update(data).digest('hex'), sound.sha256, sound.id);
    totalBytes += data.length;
  }
  assert.ok(totalBytes < 500_000, 'Keep the initial audio bank lightweight');
});
