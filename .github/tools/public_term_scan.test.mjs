// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseTerms, scanText } from './public_term_scan.mjs';

test('a clean public message passes with an empty blocklist', () => {
  assert.deepEqual(scanText('A clean description of the feature.', []), []);
});

test('configured terms are literal and case-insensitive', () => {
  assert.deepEqual(scanText('PrivateCodename has shipped.', ['privatecodename']), ['configured public term']);
});

test('personal paths and credential-shaped text are rejected', () => {
  assert.equal(scanText('/Users/example/project', []).length, 1);
  assert.equal(scanText('/home/example/project', []).length, 1);
  assert.equal(scanText(`ghp_${'x'.repeat(20)}`, []).length, 1);
});

test('malformed blocklists fail closed', () => {
  for (const value of ['not json', '{}', '[1]', '[""]']) assert.throws(() => parseTerms(value));
});
