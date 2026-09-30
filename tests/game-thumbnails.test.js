import test from 'node:test';
import assert from 'node:assert/strict';
import { GameThumbnails } from '../src/game-thumbnails.js';

test('publishing another revision replaces the cached image even when its filename is unchanged', () => {
  let redraws = 0;
  const cache = new GameThumbnails(() => redraws++, () => ({}));
  const original = { id: 'race', screenshot: '/cartridges/race/thumbnail.png', revision: 'old' };
  cache.load(original);
  const image = cache.get(original);
  const lateLoad = image.onload;
  cache.load(original);
  assert.equal(cache.get(original), image);
  const updated = { ...original, revision: 'new' };
  assert.equal(cache.get(updated), null, 'never display the old image under the new manifest');
  cache.load(updated);
  assert.equal(image.onload, null);
  assert.notEqual(cache.get(updated), image);
  assert.match(cache.get(updated).src, /revision=new$/);
  lateLoad();
  assert.equal(redraws, 0);
  cache.get(updated).onload();
  assert.equal(redraws, 1);
  assert.equal(cache.images.size, 1, 'no accumulating revision history');
});

test('games never share image identity, removed images and missing thumbnails discard stale data', () => {
  const cache = new GameThumbnails(() => {}, () => ({}));
  const a = { id: 'a', screenshot: '/shared.png?size=small', revision: '1' };
  const b = { ...a, id: 'b' };
  cache.load(a); cache.load(b);
  assert.notEqual(cache.get(a), cache.get(b));
  assert.equal(cache.get(a).src, '/shared.png?size=small&revision=1');
  cache.retain([a]);
  assert.equal(cache.get(b), null);
  cache.load({ ...a, screenshot: '' });
  assert.equal(cache.get(a), null);
  assert.equal(cache.images.size, 0);
});
