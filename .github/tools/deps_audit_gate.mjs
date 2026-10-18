// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function unexpectedAdvisories(report, baseline) {
  if (!report || !report.advisories || !Array.isArray(baseline.advisories)) throw new Error('Invalid audit report or baseline');
  const known = new Set(baseline.advisories.map(row => JSON.stringify([row.id, row.package, row.version, row.path])));
  const unexpected = [];
  for (const advisory of Object.values(report.advisories)) {
    if (!['high', 'critical'].includes(advisory.severity)) continue;
    for (const finding of advisory.findings ?? []) {
      for (const path of finding.paths ?? []) {
        const key = JSON.stringify([advisory.id, advisory.module_name, finding.version, path]);
        if (!known.has(key)) unexpected.push(`${advisory.module_name}@${finding.version}: ${path} (advisory ${advisory.id})`);
      }
    }
  }
  return unexpected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const baseline = JSON.parse(readFileSync(new URL('../deps-audit-baseline.json', import.meta.url), 'utf8'));
    const unexpected = unexpectedAdvisories(report, baseline);
    if (unexpected.length) {
      for (const finding of unexpected) console.error(`::error::New production audit finding: ${finding}`);
      process.exitCode = 1;
    } else {
      console.log(`::notice::Only ${Object.keys(report.advisories).length} previously recorded production advisories remain.`);
    }
  } catch (error) {
    console.error(`::error::Audit could not be checked: ${error.message}`);
    process.exitCode = 2;
  }
}
