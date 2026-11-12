import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAgents } from './agent-detector.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mobile-agent-detection-'));
  for (const name of ['qwen', 'codex', 'npx']) {
    await writeFile(
      join(directory, name),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(directory, name + '-probed'))}, 'yes');\nconsole.log('fixture-cli 1.0');\n`,
      { mode: 0o755 },
    );
  }
  vi.stubEnv('PATH', directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it('lists installed mobile backends without spawning a timed version probe', async () => {
  const agents = detectAgents({
    names: ['qwen', 'codex'],
    probeVersions: false,
  });
  expect(agents.map((agent) => agent.name)).toEqual(['qwen', 'codex']);
  expect(agents[1]!.env?.['CODEX_PATH']).toBe(join(directory, 'codex'));
  expect(agents[1]!.command).toBe(join(directory, 'npx'));
  await expect(access(join(directory, 'qwen-probed'))).rejects.toThrow();
  await expect(access(join(directory, 'codex-probed'))).rejects.toThrow();
});

it('preserves default version probing and supports filtering before probes', async () => {
  const agents = detectAgents({ names: ['qwen'] });
  expect(agents).toHaveLength(1);
  expect(agents[0]!.version).toBe('fixture-cli 1.0');
  await expect(access(join(directory, 'qwen-probed'))).resolves.toBeUndefined();
  await expect(access(join(directory, 'codex-probed'))).rejects.toThrow();
});

it('keeps empty version output unavailable to the ordinary setup wizard', async () => {
  await writeFile(
    join(directory, 'codex'),
    `#!${process.execPath}\nprocess.exit(0);\n`,
    { mode: 0o755 },
  );
  expect(detectAgents({ names: ['codex'] })).toEqual([]);
  expect(detectAgents({ names: ['codex'], probeVersions: false })).toHaveLength(
    1,
  );
});
