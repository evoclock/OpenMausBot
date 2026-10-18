import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = (name: string) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
const ci = workflow('ci.yml');

// The CI contract intentionally replaces the upstream release/deploy jobs.
describe('repository CI and release boundaries', () => {
  it('runs independent, read-only typecheck, lint, and test jobs on PRs and main', () => {
    expect(ci.on).toEqual({ pull_request: null, push: { branches: ['main'] } });
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(ci.jobs)).toEqual(['typecheck', 'lint', 'test-shard', 'test']);
    expect(ci.jobs['test-shard'].strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
    expect(ci.jobs.test.needs).toEqual(['test-shard']);
    expect(ci.jobs.test.if).toBe('always()');
    expect(ci.jobs.test.steps[0].env.SHARD_RESULT).toBe('${{ needs.test-shard.result }}');
    expect(ci.jobs.test.steps[0].run).toBe('test "$SHARD_RESULT" = success');
    for (const [name, command] of [['typecheck', 'pnpm typecheck'], ['lint', 'pnpm lint'], ['test-shard', 'pnpm exec vitest run --shard=${{ matrix.shard }}/4']]) {
      const steps = ci.jobs[name].steps;
      expect(steps.some((step: { run?: string }) => step.run === 'pnpm install --frozen-lockfile')).toBe(true);
      expect(steps.some((step: { run?: string }) => step.run === command)).toBe(true);
      expect(steps.some((step: { uses?: string }) => step.uses?.startsWith('pnpm/action-setup@'))).toBe(true);
      expect(steps.some((step: { uses?: string; with?: { cache?: string } }) => step.uses?.startsWith('actions/setup-node@') && step.with?.cache === 'pnpm')).toBe(true);
    }
  });

  it('keeps the closed-PR stop in the same group without cancelling main', () => {
    const stop = workflow('ci-stop-closed.yml');
    expect(stop.concurrency.group).toBe('ci-pr-${{ github.event.pull_request.number }}');
    expect(ci.concurrency.group).toContain("format('pr-{0}', github.event.pull_request.number)");
    expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
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
