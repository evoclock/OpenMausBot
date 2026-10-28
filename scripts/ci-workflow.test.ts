import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = (name: string) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const ci = parse(readFileSync(new URL('../.buildkite/pipeline.yml', import.meta.url), 'utf8'));

// The CI contract intentionally replaces the upstream release/deploy jobs.
describe('repository CI and release boundaries', () => {
  it('runs typecheck, lint, and every test shard on the Mac for PRs and main', () => {
    const steps = ci.steps.filter((step: { label?: string }) => step.label);
    expect(steps.every((step: { agents?: { queue?: string }; timeout_in_minutes?: number; priority?: number }) =>
      step.agents?.queue === 'mac-mini' && step.timeout_in_minutes! > 0 && step.priority === -1)).toBe(true);
    expect(steps.find((step: { label: string }) => step.label === 'Typecheck').command).toContain('pnpm typecheck');
    expect(steps.find((step: { label: string }) => step.label === 'Lint and policy tests').command).toContain('pnpm lint');
    const main = steps.filter((step: { label: string }) => /^Tests [1-4]\/4$/.test(step.label));
    expect(main.map((step: { command: string[] }) => step.command.at(-1))).toEqual([1, 2, 3, 4].map((shard) => `pnpm exec vitest run --shard=${shard}/4 --exclude '**/*recovery.e2e.test.ts' --exclude '**/steer-e2e.test.ts'`));
    expect(main.every((step: { if: string }) => step.if === 'build.pull_request.id == null')).toBe(true);
    const pr = steps.filter((step: { label: string }) => /^PR Mac tests [1-8]\/8$/.test(step.label));
    expect(pr.map((step: { env: { SHARD_INDEX: string } }) => Number(step.env.SHARD_INDEX))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pr.every((step: { if: string; command: string[] }) => step.if === 'build.pull_request.id != null'
      && step.command.some((command) => command.includes("pnpm exec vitest run --shard=$$((SHARD_INDEX+1))/8 --exclude '**/*recovery.e2e.test.ts' --exclude '**/steer-e2e.test.ts'")))).toBe(true);
    expect(pr.every((step: { artifact_paths?: string[] }) => step.artifact_paths?.includes('.omb-scratch/buildkite-reports/vitest-*.json')
      && step.artifact_paths.includes('.omb-scratch/buildkite-reports/junit-*.xml'))).toBe(true);
    const recovery = steps.filter((step: { label: string }) => step.label === 'Recovery e2e');
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({
      agents: { queue: 'mac-mini' },
      concurrency: 1,
      concurrency_group: 'openmausbot-recovery-e2e-mac-mini',
    });
    expect(recovery[0].command.at(-1)).toBe('pnpm exec vitest run server/*recovery.e2e.test.ts');
    const steering = steps.filter((step: { label: string }) => step.label === 'Steering e2e');
    expect(steering).toHaveLength(1);
    expect(steering[0]).toMatchObject({
      agents: { queue: 'mac-mini' },
      concurrency: 1,
      concurrency_group: 'openmausbot-steer-e2e-mac-mini',
    });
    expect(steering[0].command.at(-1)).toBe('pnpm exec vitest run server/steer-e2e.test.ts');
    const wait = ci.steps.findIndex((step: { wait?: unknown }) => step.wait !== undefined);
    expect(wait).toBeGreaterThan(ci.steps.findIndex((step: { label?: string }) => step.label === 'Recovery e2e'));
    expect(ci.steps[wait].wait.continue_on_failure).toBe(true);
    expect(ci.steps[wait + 1].label).toBe('Steering e2e');
  });

  it('keeps policy gates on GitHub and test-style PR checks on Buildkite', () => {
    const labels = ci.steps.map((step: { label?: string }) => step.label);
    expect(labels).toContain('Dependencies');
    expect(labels).toContain('Docs');
    expect(labels).not.toContain('Author check');
    expect(labels).not.toContain('PR wording');
    expect(labels).not.toContain('PR review gate');
    expect(Object.keys(workflow('author-check.yml').jobs)).toEqual(['author-check']);
    expect(Object.keys(workflow('pr-wording.yml').jobs)).toEqual(['pr-wording']);
    expect(Object.keys(workflow('pr-review-gate.yml').jobs)).toEqual(['pr-review-gate']);
    const windows = workflow('browser-vendor-windows.yml');
    expect(windows.jobs.smoke['runs-on']).toBe('windows-latest');
    expect(windows.jobs.build.env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER).toBe('x86_64-w64-mingw32-gcc');
    expect(readdirSync(new URL('../.github/workflows/', import.meta.url)).sort()).toEqual([
      'author-check.yml', 'browser-vendor-windows.yml', 'pr-review-gate.yml', 'pr-wording.yml', 'release.yml',
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
