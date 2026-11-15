import { afterEach, expect, it, vi } from 'vitest';
import { parseOptions } from './options.js';

afterEach(() => vi.unstubAllEnvs());

it('uses an explicit public host over the environment default and rejects URLs', () => {
  vi.stubEnv('AGENT_REMOTE_PUBLIC_HOST', 'remote.example.test');
  expect(parseOptions([]).publicHost).toBe('remote.example.test');
  expect(parseOptions(['--public-host', '203.0.113.8']).publicHost).toBe(
    '203.0.113.8',
  );
  expect(() =>
    parseOptions(['--public-host', 'https://other.example.test']),
  ).toThrow();
  expect(() => parseOptions(['--public-host'])).toThrow('incomplete option');
});
