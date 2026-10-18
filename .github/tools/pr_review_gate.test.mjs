// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { evaluatePrReviewGate, checkReviewFreeze } from './pr_review_gate.js';

const sha = 'a'.repeat(40);
const review = { user: 'reviewer', state: 'APPROVED', commit_id: sha, submitted_at: '2026-01-01T00:00:00Z' };
const pr = (overrides = {}) => ({ headSha: sha, author: 'maintainer', reviews: [], reviewComments: [], issueComments: [], commits: [], ...overrides });

test('sole maintainer author needs no approval, but outstanding changes still block', () => {
  assert.equal(evaluatePrReviewGate(pr({ maintainers: ['maintainer'] })).ok, true);
  assert.equal(checkReviewFreeze(pr({ maintainers: ['maintainer'], reviews: [{ ...review, state: 'CHANGES_REQUESTED' }] })).ok, false);
});

test('unknown or multiple maintainers require a current approval', () => {
  assert.equal(evaluatePrReviewGate(pr({ maintainers: null })).ok, false);
  assert.equal(evaluatePrReviewGate(pr({ maintainers: ['maintainer', 'reviewer'] })).ok, false);
  assert.equal(evaluatePrReviewGate(pr({ maintainers: ['maintainer', 'reviewer'], reviews: [review] })).ok, true);
  assert.equal(evaluatePrReviewGate(pr({ maintainers: ['maintainer'], reviews: [{ ...review, commit_id: 'b'.repeat(40) }] })).ok, false);
});

test('draft PR defers the review gate', () => {
  assert.equal(evaluatePrReviewGate(pr({ draft: true })).ok, true);
});
