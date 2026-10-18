// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { unexpectedAdvisories } from './deps_audit_gate.mjs';

const baseline = { advisories: [{ id: 1, package: 'example', version: '1.0.0', path: '.>example' }] };
const report = (id = 1, path = '.>example') => ({ advisories: { [id]: {
  id, severity: 'high', module_name: 'example', findings: [{ version: '1.0.0', paths: [path] }],
} } });

test('only the exact already-present version and path is nonblocking', () => {
  assert.deepEqual(unexpectedAdvisories(report(), baseline), []);
  assert.equal(unexpectedAdvisories(report(2), baseline).length, 1);
  assert.equal(unexpectedAdvisories(report(1, '.>new>example'), baseline).length, 1);
});

test('missing audit data fails closed', () => {
  assert.throws(() => unexpectedAdvisories({}, baseline));
});
