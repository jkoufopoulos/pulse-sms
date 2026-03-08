# Conversations to SQLite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move saved simulator conversations from ephemeral flat files to the SQLite database so they survive Railway deploys and can be queried for analysis.

**Architecture:** Add a `conversations` table to `db.js`. Replace the flat-file save/read in `traces.js` and `server.js` with SQLite calls. Keep the in-memory conversation tracking (it aggregates turns during a session) but change the persistence layer. Remove dead flat-file code.

**Tech Stack:** better-sqlite3 (already in use), existing `db.js` migration pattern

---

### Task 1: Add `conversations` table to SQLite

**Files:**
- Modify: `src/db.js:30-103` (add table to `runMigrations`)

**Step 1: Write the failing test**

```js
// test/unit/db-conversations.test.js
const { getDb, closeDb } = require('../../src/db');

afterAll(() => closeDb());

test('conversations table exists after migration', () => {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get();
  expect(tables).toBeTruthy();
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/db-conversations.test.js -v`
Expected: FAIL — no `conversations` table

**Step 3: Add the table to `runMigrations` in `src/db.js`**

Add after the `daily_digests` CREATE TABLE block (inside the same `db.exec` template literal):

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_masked TEXT NOT NULL,
  label TEXT,
  first_message TEXT,
  started_at TEXT,
  saved_at TEXT NOT NULL,
  turn_count INTEGER NOT NULL,
  turns TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_saved ON conversations(saved_at);
```

**Step 4: Run test to verify it passes**

Run: `npx jest test/unit/db-conversations.test.js -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/db.js test/unit/db-conversations.test.js
git commit -m "feat: add conversations table to SQLite schema"
```

---

### Task 2: Add `saveConversationToDb` and `getSavedConversations` to `db.js`

**Files:**
- Modify: `src/db.js` (add two functions + exports)
- Modify: `test/unit/db-conversations.test.js` (add tests)

**Step 1: Write the failing tests**

Append to `test/unit/db-conversations.test.js`:

```js
const { saveConversationToDb, getSavedConversations } = require('../../src/db');

test('saveConversationToDb inserts and returns id', () => {
  const result = saveConversationToDb({
    phone_masked: '+*******5001',
    label: 'greenpoint test',
    first_message: 'greenpoint',
    started_at: '2026-03-08T12:00:00Z',
    turn_count: 4,
    turns: [
      { sender: 'user', message: 'greenpoint' },
      { sender: 'pulse', message: 'Here are some picks...' },
    ],
  });
  expect(result.ok).toBe(true);
  expect(result.id).toBeGreaterThan(0);
  expect(result.turn_count).toBe(4);
});

test('getSavedConversations returns summaries sorted by saved_at desc', () => {
  // Insert a second conversation
  saveConversationToDb({
    phone_masked: '+*******5002',
    label: 'bushwick vibes',
    first_message: 'bushwick',
    started_at: '2026-03-08T13:00:00Z',
    turn_count: 6,
    turns: [{ sender: 'user', message: 'bushwick' }],
  });

  const list = getSavedConversations();
  expect(list.length).toBeGreaterThanOrEqual(2);
  // Most recent first
  expect(list[0].label).toBe('bushwick vibes');
});

test('getSavedConversations with id returns full turns', () => {
  const all = getSavedConversations();
  const full = getSavedConversations(all[0].id);
  expect(full.turns).toBeDefined();
  expect(Array.isArray(full.turns)).toBe(true);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest test/unit/db-conversations.test.js -v`
Expected: FAIL — functions not exported

**Step 3: Implement in `src/db.js`**

Add before the `module.exports`:

```js
function saveConversationToDb({ phone_masked, label, first_message, started_at, turn_count, turns }) {
  const d = getDb();
  const saved_at = new Date().toISOString();
  const result = d.prepare(`
    INSERT INTO conversations (phone_masked, label, first_message, started_at, saved_at, turn_count, turns)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(phone_masked, label || null, first_message || null, started_at || null, saved_at, turn_count, JSON.stringify(turns));
  return { ok: true, id: result.lastInsertRowid, turn_count };
}

function getSavedConversations(id) {
  const d = getDb();
  if (id) {
    const row = d.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, turns: JSON.parse(row.turns) };
  }
  return d.prepare(
    'SELECT id, phone_masked, label, first_message, started_at, saved_at, turn_count FROM conversations ORDER BY saved_at DESC'
  ).all();
}
```

Add `saveConversationToDb` and `getSavedConversations` to `module.exports`.

**Step 4: Run tests to verify they pass**

Run: `npx jest test/unit/db-conversations.test.js -v`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/db.js test/unit/db-conversations.test.js
git commit -m "feat: add saveConversationToDb and getSavedConversations"
```

---

### Task 3: Wire `saveConversation` in traces.js to use SQLite

**Files:**
- Modify: `src/traces.js:376-412` (replace `saveConversation` internals)

**Step 1: Write the failing test**

```js
// In test/unit/db-conversations.test.js, add:
test('saveConversation from traces uses SQLite', () => {
  const { saveConversation, recordConversationTurn } = require('../../src/traces');
  // Simulate a conversation in the in-memory map
  const phone = '+15551234567';
  process.env.PULSE_TEST_MODE = 'true';
  recordConversationTurn({
    phone_masked: '+*******4567',
    input_message: 'les',
    output_sms: 'Here are picks for LES...',
    timestamp: new Date().toISOString(),
    id: 'test-trace-1',
    output_intent: 'search',
    total_latency_ms: 100,
    total_ai_cost_usd: 0.001,
  });

  const result = saveConversation(phone, { label: 'sqlite test' });
  expect(result.ok).toBe(true);
  expect(result.id).toBeGreaterThan(0);

  // Verify it's in SQLite
  const saved = getSavedConversations(result.id);
  expect(saved.label).toBe('sqlite test');
  expect(saved.turns.length).toBe(2); // user + pulse
  delete process.env.PULSE_TEST_MODE;
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/db-conversations.test.js -v`
Expected: FAIL — `result.id` is undefined (flat file returns `filepath` not `id`)

**Step 3: Replace `saveConversation` in `src/traces.js`**

Replace the entire `saveConversation` function body with:

```js
function saveConversation(rawPhone, { label } = {}) {
  const { maskPhone } = require('./twilio');
  const { saveConversationToDb } = require('./db');
  const masked = maskPhone(rawPhone);
  const conv = conversations.get(masked);
  if (!conv || conv.turns.length === 0) {
    return { ok: false, error: 'No active conversation for this phone' };
  }

  const firstUserMsg = conv.turns.find(t => t.sender === 'user')?.message || '';
  return saveConversationToDb({
    phone_masked: masked,
    label: label || null,
    first_message: firstUserMsg,
    started_at: conv.startedAt,
    turn_count: conv.turns.length,
    turns: conv.turns,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx jest test/unit/db-conversations.test.js -v`
Expected: PASS

**Step 5: Commit**

```bash
git add src/traces.js
git commit -m "feat: saveConversation now writes to SQLite instead of flat files"
```

---

### Task 4: Wire `/api/conversations/saved` to read from SQLite

**Files:**
- Modify: `src/server.js:448-465` (replace filesystem reads with db calls)

**Step 1: Update the server route**

Replace the `GET /api/conversations/saved` handler with:

```js
app.get('/api/conversations/saved', (req, res) => {
  const { getSavedConversations } = require('./db');
  if (req.query.id) {
    const conv = getSavedConversations(Number(req.query.id));
    if (!conv) return res.status(404).json({ error: 'Not found' });
    return res.json(conv);
  }
  res.json(getSavedConversations());
});
```

Note: query param changes from `?file=filename.json` to `?id=123`. The simulator UI doesn't currently read saved conversations (it only writes), so no frontend change needed.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: /api/conversations/saved reads from SQLite"
```

---

### Task 5: Clean up dead flat-file code

**Files:**
- Modify: `src/traces.js` (remove `SAVED_DIR`, `CONVERSATIONS_DIR`, flat-file flush code)
- Modify: `src/server.js` (remove `startConversationCapture` import if no longer needed)

**Step 1: Remove from `src/traces.js`**

- Delete constant: `CONVERSATIONS_DIR` (line 14)
- Delete constants: `CONVERSATION_IDLE_MS`, `CONVERSATION_CHECK_MS` (lines 23-24)
- Delete constant: `SAVED_DIR` (line 368)
- Delete function: `flushConversation` (lines 303-321)
- Delete function: `flushIdleConversations` (lines 326-334)
- Delete function: `flushAllConversations` (lines 339-344)
- Delete function: `startConversationCapture` (lines 349-355)
- Delete function: `stopConversationCapture` (lines 360-366)
- Remove from exports: `startConversationCapture`, `stopConversationCapture`
- Keep: `recordConversationTurn` (still needed to populate the in-memory map), `saveConversation` (rewritten in Task 3), `conversations` Map

**Step 2: Update `src/server.js`**

- Remove `startConversationCapture` from the require on line 414
- Remove `startConversationCapture()` call on line 416
- Remove `stopConversationCapture()` call in shutdown handler (line 633)

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/traces.js src/server.js
git commit -m "chore: remove flat-file conversation persistence code"
```

---

### Task 6: Update simulator Save button response

**Files:**
- Modify: `src/test-ui.html:430-457` (update success message to show id instead of filepath)

**Step 1: Update the `saveSession` function in test-ui.html**

Change the success message line from:
```js
addMessage(`Session saved (${data.turn_count} turns) → ${data.filepath}`, 'system');
```
to:
```js
addMessage(`Session saved (${data.turn_count} turns) → conversation #${data.id}`, 'system');
```

**Step 2: Manual test on local**

Run: `PULSE_TEST_MODE=true npm run dev`
Open simulator, have a conversation, click Save, confirm message shows `conversation #N`.

**Step 3: Commit**

```bash
git add src/test-ui.html
git commit -m "chore: update simulator save message to show conversation id"
```
