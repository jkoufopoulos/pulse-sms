const { check } = require('../helpers');
const crypto = require('crypto');

console.log('\nExtraction Cache:');

const {
  getCachedExtraction,
  setCachedExtraction,
  _computeHash,
  _getCache,
  _setCache,
} = require('../../src/extraction-cache');

// ---- Hash computation ----
console.log('\nhash computation:');

const hash1 = _computeHash('some raw html content');
check('hash is a 64-char hex string', typeof hash1 === 'string' && hash1.length === 64 && /^[0-9a-f]+$/.test(hash1));

const hash2 = _computeHash('some raw html content');
check('same content produces same hash', hash1 === hash2);

const hash3 = _computeHash('different content');
check('different content produces different hash', hash1 !== hash3);

// Verify the hash includes the NYC date
const nycDateString = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
const expectedHash = crypto.createHash('sha256').update(nycDateString + 'test content').digest('hex');
const actualHash = _computeHash('test content');
check('hash includes NYC date component', actualHash === expectedHash);

// ---- Cache miss ----
console.log('\ncache miss:');

_setCache({});
const missResult = getCachedExtraction('test-source', 'brand new content');
check('returns null on cache miss', missResult === null);

// ---- Cache hit ----
console.log('\ncache hit:');

_setCache({});
const testEvents = [{ name: 'Test Event', date_local: '2026-03-15' }];
setCachedExtraction('test-source', 'cached content', testEvents);

const hitResult = getCachedExtraction('test-source', 'cached content');
check('returns events array on cache hit', Array.isArray(hitResult));
check('cached events match original', hitResult.length === 1 && hitResult[0].name === 'Test Event');

// ---- Cache miss on content change ----
console.log('\ncache invalidation (content change):');

const changedResult = getCachedExtraction('test-source', 'different content now');
check('returns null when content changes', changedResult === null);

// ---- Cache structure ----
console.log('\ncache structure:');

_setCache({});
setCachedExtraction('my-source', 'html', [{ name: 'A' }]);
const cache = _getCache();
check('cache has source key', 'my-source' in cache);
check('entry has hash', typeof cache['my-source'].hash === 'string');
check('entry has events', Array.isArray(cache['my-source'].events));
check('entry has timestamp', typeof cache['my-source'].timestamp === 'string');

// ---- Date-based invalidation ----
console.log('\ndate-based invalidation:');

// Simulate a stale cache entry with a hash from a different date
const staleHash = crypto.createHash('sha256').update('12/31/1999' + 'same content').digest('hex');
_setCache({
  'stale-source': {
    hash: staleHash,
    events: [{ name: 'Stale' }],
    timestamp: '1999-12-31T00:00:00.000Z',
  },
});

const staleResult = getCachedExtraction('stale-source', 'same content');
check('stale date hash causes cache miss', staleResult === null);

// ---- Multiple sources ----
console.log('\nmultiple sources:');

_setCache({});
setCachedExtraction('source-a', 'content-a', [{ name: 'A' }]);
setCachedExtraction('source-b', 'content-b', [{ name: 'B1' }, { name: 'B2' }]);

const resultA = getCachedExtraction('source-a', 'content-a');
const resultB = getCachedExtraction('source-b', 'content-b');
check('source-a returns its events', resultA.length === 1 && resultA[0].name === 'A');
check('source-b returns its events', resultB.length === 2);
check('sources are independent', getCachedExtraction('source-a', 'content-b') === null);

// Clean up — reset cache to empty
_setCache({});
