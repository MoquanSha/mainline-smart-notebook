import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNewerState } from '../src/state-order.ts';

test('delayed submit or event responses cannot hide newer committed diary progress', () => {
  const state = (localRevision, summary) => ({ meta: { localRevision }, status: { dataScope: 'profile-A' }, summary });
  const pending = state(10, 'pending'), complete = state(12, 'organized');
  assert.equal(selectNewerState(complete, pending), complete);
  assert.equal(selectNewerState(pending, complete), complete);
  assert.equal(selectNewerState(null, pending), pending);
  const other = { ...pending, status: { dataScope: 'profile-B' } };
  assert.equal(selectNewerState(complete, other), other);
});
