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
    expect(main.map((step: { command: string[] }) => step.command.at(-1))).toEqual([1, 2, 3, 4].map((shard) => `pnpm exec vitest run --shard=${shard}/4`));
    expect(main.every((step: { if: string }) => step.if === 'build.pull_request.id == null')).toBe(true);
    const pr = steps.filter((step: { label: string }) => /^PR Mac tests [1-8]\/8$/.test(step.label));
    expect(pr.map((step: { env: { SHARD_INDEX: string } }) => Number(step.env.SHARD_INDEX))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pr.every((step: { if: string; command: string[] }) => step.if === 'build.pull_request.id != null'
      && step.command.some((command) => command.includes('pnpm exec vitest run --shard=$$((SHARD_INDEX+1))/8')))).toBe(true);
  });

  it('runs PR checks on Buildkite and keeps platform-specific jobs on GitHub', () => {
    expect(['Dependencies', 'Docs', 'Author check', 'PR wording', 'PR review gate'].every((label) =>
      ci.steps.some((step: { label?: string }) => step.label === label))).toBe(true);
    const windows = workflow('browser-vendor-windows.yml');
    expect(windows.jobs.smoke['runs-on']).toBe('windows-latest');
    expect(windows.jobs.build.env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER).toBe('x86_64-w64-mingw32-gcc');
    expect(readdirSync(new URL('../.github/workflows/', import.meta.url)).sort()).toEqual(['browser-vendor-windows.yml', 'release.yml']);
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
