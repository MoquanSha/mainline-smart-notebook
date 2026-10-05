import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const appSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');

test('daily diary drafts reload on scope changes and persist through one guarded writer', () => {
  assert.match(appSource, /useEffect\(\(\) => \{\s*const next = loadDiaryDraft\(\);\s*draftScopeRef\.current = draftKey/s);
  assert.match(appSource, /const activeDiaryDraft = draftScopeRef\.current === draftKey \? diaryDraft : emptyDiaryDraft\(\)/);
  assert.match(appSource, /const persistDiaryDraft = \(next: DiaryDraft\) => \{/);
  assert.match(appSource, /clearOnlyAfterPersist/);
  assert.equal((appSource.match(/window\.localStorage\.setItem\(draftKey/g) || []).length, 1,
    'daily diary writes must go through the guarded persistence function');
});

test('async organize and import callbacks cannot write a result into a changed data scope', () => {
  assert.equal((appSource.match(/const expectedDataScope = activeDataScope\.current;/g) || []).length, 3,
    'auto organize, manual organize, and import each capture the initiating scope');
  assert.ok((appSource.match(/activeDataScope\.current !== expectedDataScope \|\| next\.status\.dataScope !== expectedDataScope/g) || []).length >= 3,
    'async results must be discarded when the active scope changed');
  assert.ok((appSource.match(/activeDataScope\.current === expectedDataScope/g) || []).length >= 3,
    'stale async failures and busy state must not affect the new scope');
});
