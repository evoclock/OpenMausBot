import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

describe('Dockerfile remains available without an active image publisher', () => {
  it('retains server and cloud-home targets for local builds', () => {
    expect(dockerfile).toMatch(/^FROM .* AS server$/m);
    expect(dockerfile).toMatch(/^FROM .* AS cloud-home$/m);
  });

  it('never exposes a registry publisher through the active workflows', () => {
    const ci = readFileSync(new URL('../.buildkite/pipeline.yml', import.meta.url), 'utf8');
    const workflows = ['ci-stop-closed.yml', 'deps.yml', 'docs.yml', 'release.yml']
      .map((name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')).join('\n');
    expect(ci + workflows).not.toMatch(/docker\/build-push-action|npm publish|docker push|ghcr\.io/);
  });
});
