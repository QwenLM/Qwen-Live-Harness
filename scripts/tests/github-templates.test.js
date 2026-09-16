import { readFileSync } from 'node:fs';
import { check, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(path, 'utf8');

describe('Qwen-Live-Harness contribution templates', () => {
  it.each([
    ['bug_report.yml', 'bug'],
    ['feature_request.yml', 'enhancement'],
  ])(
    'keeps %s valid, formatted and scoped to this repository',
    async (file, label) => {
      const path = `.github/ISSUE_TEMPLATE/${file}`;
      const content = read(path);
      expect(
        await check(content, {
          ...(await resolveConfig(path)),
          filepath: path,
        }),
      ).toBe(true);
      expect(content).toContain(
        'https://github.com/QwenLM/Qwen-Live-Harness/issues',
      );
      expect(content).toContain(`'${label}'`);
      expect(content).not.toContain('github.com/QwenLM/qwen-code');
      const ids = [...content.matchAll(/^\s+id: '([^']+)'$/gmu)].map(
        (match) => match[1],
      );
      expect(ids.length).toBeGreaterThan(1);
      expect(new Set(ids).size).toBe(ids.length);
      expect(content).toContain('required: true');
    },
  );

  it('requests safe diagnostics and points to the actual Host log directory', () => {
    const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml');
    const host = JSON.parse(
      read('packages/qwen-live-harness-host/package.json'),
    );
    expect(bug).toContain(
      `Application Support/${host.name}/logs/host-errors.log`,
    );
    expect(bug).toContain('Do not include API keys');
    expect(bug).toContain('Background Harness and version (or none)');
    expect(bug).toContain('npm ls -g qwen-live-harness --depth=0');
    expect(bug).not.toContain('qwen-live-harness --version');
    expect(bug).not.toContain('/about');
  });

  it('keeps the upstream review structure without unsupported project workflows', () => {
    const pr = read('.github/pull_request_template.md');
    for (const heading of [
      'What this PR does',
      "Why it's needed",
      'Reviewer Test Plan',
      'Risk & Scope',
      'Linked Issues',
    ]) {
      expect(pr).toContain(`## ${heading}`);
    }
    expect(pr).toContain('npm start');
    expect(pr).toContain('macOS Host');
    expect(pr).toContain('中文说明（可选）');
    expect(pr).not.toContain('github.com/QwenLM/qwen-code');
    expect(pr).not.toContain('tmux');
  });
});
