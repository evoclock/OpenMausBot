import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCiContract } from './check-ci-contract.mjs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = (name: string) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const ci = parse(readFileSync(new URL('../.buildkite/pipeline.yml', import.meta.url), 'utf8'));

// Tip CI lives on GitHub Actions; Buildkite tip is an intentional noop (Accept SoA t296).
describe('repository CI and release boundaries', () => {
  it('rejects a tip-config-only change and accepts a paired contract change', () => {
    expect(() => checkCiContract(['.buildkite/pipeline.yml'])).toThrow(/scripts\/ci-workflow\.test\.ts/);
    expect(() => checkCiContract(['.github/workflows/tip-ci.yml'])).toThrow(/scripts\/ci-workflow\.test\.ts/);
    expect(() => checkCiContract(['.buildkite/pipeline.yml', 'scripts/ci-workflow.test.ts'])).not.toThrow();
    expect(() => checkCiContract(['.github/workflows/tip-ci.yml', 'scripts/ci-workflow.test.ts'])).not.toThrow();
    expect(() => checkCiContract(['docs/ci.md'])).not.toThrow();
  });

  // Self-contained: the checkout running Vitest may lack origin/main or hold a stale one.
  it('fails the CLI on a tip-config-only branch diff and passes once the contract co-changes', () => {
    const script = fileURLToPath(new URL('./check-ci-contract.mjs', import.meta.url));
    const repo = mkdtempSync(join(tmpdir(), 'omb-ci-contract-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    };
    const write = (path: string, body: string) => {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), body);
    };
    const guard = () => spawnSync(process.execPath, [script, 'base', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '--quiet', '--initial-branch=base');
      write('.github/workflows/tip-ci.yml', 'name: Tip CI\n');
      write('scripts/ci-workflow.test.ts', '// contract\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'base');
      git('checkout', '--quiet', '-b', 'change');
      write('.github/workflows/tip-ci.yml', 'name: Tip CI\non: {}\n');
      git('commit', '--quiet', '-am', 'tip-ci only');
      const tipOnly = guard();
      expect(tipOnly.status).toBe(1);
      expect(tipOnly.stderr).toContain('changed without scripts/ci-workflow.test.ts');
      write('scripts/ci-workflow.test.ts', '// contract updated\n');
      git('commit', '--quiet', '-am', 'contract');
      const paired = guard();
      expect(paired.status, paired.stderr).toBe(0);
      expect(paired.stdout).toContain('CI contract co-change: OK');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('runs tip gates on GitHub Actions ubuntu Tip CI', () => {
    const tip = workflow('tip-ci.yml');
    expect(tip.name).toBe('Tip CI');
    expect(tip.on.pull_request.branches).toEqual(['main']);
    expect(tip.on.push.branches).toEqual(['main']);
    expect(tip.jobs.typecheck['runs-on']).toBe('ubuntu-latest');
    expect(tip.jobs.lint['runs-on']).toBe('ubuntu-latest');
    expect(tip.jobs.test['runs-on']).toBe('ubuntu-latest');
    expect(tip.jobs.docs['runs-on']).toBe('ubuntu-latest');
    expect(tip.jobs.test.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    const vitest = tip.jobs.test.steps.find((step: { name?: string }) => step.name?.startsWith('Vitest shard'));
    expect(vitest.run).toContain("--shard=${{ matrix.shard }}/4");
    expect(vitest.run).toContain("--exclude '**/*recovery.e2e.test.ts'");
    expect(vitest.run).toContain("--exclude '**/helper-model.e2e.test.ts'");
    expect(vitest.run).toContain("--exclude '**/steer-e2e.test.ts'");
    // Required branch-protection check name (job name on the tip gate).
    expect(tip.jobs.tip.name).toBe('typecheck / lint / tests');
    expect(tip.jobs.tip.needs).toEqual(['typecheck', 'lint', 'test', 'docs']);
    const lintRuns = tip.jobs.lint.steps.filter((step: { run?: string }) => typeof step.run === 'string').map((step: { run: string }) => step.run);
    expect(lintRuns).toContain('git fetch --quiet origin main');
    expect(lintRuns).toContain('node scripts/check-ci-contract.mjs origin/main HEAD');
  });

  it('keeps Buildkite tip as a noop off Mac agents', () => {
    const steps = ci.steps.filter((step: { label?: string }) => step.label);
    expect(steps).toHaveLength(1);
    expect(steps[0].label).toBe('Tip CI moved to GitHub Actions');
    expect(steps[0].command).toContain('GitHub Actions');
    expect(steps[0].agents).toBeUndefined();
  });

  it('keeps policy gates and release on GitHub alongside Tip CI', () => {
    expect(Object.keys(workflow('author-check.yml').jobs)).toEqual(['author-check']);
    expect(Object.keys(workflow('pr-wording.yml').jobs)).toEqual(['pr-wording']);
    expect(Object.keys(workflow('pr-review-gate.yml').jobs)).toEqual(['pr-review-gate']);
    const windows = workflow('browser-vendor-windows.yml');
    expect(windows.jobs.smoke['runs-on']).toBe('windows-latest');
    expect(windows.jobs.build.env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER).toBe('x86_64-w64-mingw32-gcc');
    expect(readdirSync(new URL('../.github/workflows/', import.meta.url)).sort()).toEqual([
      'author-check.yml',
      'browser-vendor-windows.yml',
      'pr-review-gate.yml',
      'pr-wording.yml',
      'release.yml',
      'tip-ci.yml',
    ]);
  });

  it('publishes only unsigned GitHub release installers from v* tags', () => {
    const release = workflow('release.yml');
    expect(release.on.push.tags).toEqual(['v*']);
    expect(release.on).toHaveProperty('workflow_dispatch');
    expect(release.permissions).toEqual({ contents: 'write' });
    expect(release.jobs.package.strategy.matrix.include).toEqual([
      { os: 'macos-latest', target: 'mac' }, { os: 'ubuntu-latest', target: 'linux' }, { os: 'windows-latest', target: 'win' },
    ]);
    expect(release.jobs.package.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    expect(release.jobs.package.steps.some((step: { run?: string }) => step.run === 'pnpm package:${{ matrix.target }}')).toBe(true);
    expect(release.jobs['github-release'].needs).toBe('package');
    expect(release.jobs['github-release'].steps.at(-1).run).toContain('gh release upload');
  });

  it('keeps all active third-party actions pinned and no registry publishing workflow active', () => {
    const files = readdirSync(new URL('../.github/workflows/', import.meta.url)).filter((file) => file.endsWith('.yml'));
    for (const file of files) {
      expect(file).not.toMatch(/^(?:npm-package|docker|sync-published-release|prepare-release|contributors|package-linux|package-win)\.yml$/);
      const text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
      for (const match of text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)) {
        expect(match[1], file).toMatch(/@[0-9a-f]{40}$/);
        expect(match[2], file).toMatch(/# v\d/);
      }
    }
  });
});
