import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLiveHostDiagnosticsEnabled } from '../../shared/diagnostics.ts';

describe('Qwen Live Harness Host diagnostics', () => {
  it('supports the public Host flag and the private renderer flag', () => {
    assert.equal(
      isLiveHostDiagnosticsEnabled(
        ['electron', '.', '--live-harness-debug'],
        {},
      ),
      true,
    );
    assert.equal(
      isLiveHostDiagnosticsEnabled(
        ['electron-helper', '--qwen-live-harness-debug'],
        {},
      ),
      true,
    );
  });

  it('supports the diagnostics environment variable', () => {
    assert.equal(
      isLiveHostDiagnosticsEnabled([], { QWEN_LIVE_HARNESS_DIAGNOSTICS: '1' }),
      true,
    );
  });

  it("does not use Electron's reserved --debug argument", () => {
    assert.equal(
      isLiveHostDiagnosticsEnabled(['electron', '.', '--debug'], {}),
      false,
    );
  });

  it('does not enable diagnostics through retired flags or environment names', () => {
    for (const flag of ['--live-debug', '--qwen-live-debug']) {
      assert.equal(
        isLiveHostDiagnosticsEnabled(['electron', '.', flag], {}),
        false,
      );
    }
    assert.equal(
      isLiveHostDiagnosticsEnabled([], { QWEN_LIVE_DIAGNOSTICS: '1' }),
      false,
    );
  });
});
