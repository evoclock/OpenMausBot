import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tipWorkflow = '.github/workflows/tip-ci.yml';
const pipeline = '.buildkite/pipeline.yml';
const contract = 'scripts/ci-workflow.test.ts';

export function checkCiContract(files) {
  const tipConfigChanged = files.includes(tipWorkflow) || files.includes(pipeline);
  if (tipConfigChanged && !files.includes(contract)) {
    throw new Error(
      `tip CI config (${tipWorkflow} or ${pipeline}) changed without ${contract}; update the CI contract test in the same PR`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [base, head] = process.argv.slice(2);
    if (!base || !head) throw new Error('Usage: node scripts/check-ci-contract.mjs <base-ref> <head-ref>');
    const diff = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`, '--'], { encoding: 'utf8' });
    if (!existsSync(contract)) throw new Error(`${contract} is missing`);
    checkCiContract(diff.split('\0'));
    console.log('CI contract co-change: OK');
  } catch (error) {
    console.error(`CI contract co-change: ${error.message}`);
    process.exitCode = 1;
  }
}
