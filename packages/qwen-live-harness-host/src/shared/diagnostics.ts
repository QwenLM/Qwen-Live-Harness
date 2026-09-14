export function isLiveHostDiagnosticsEnabled(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    environment['QWEN_LIVE_HARNESS_DIAGNOSTICS'] === '1' ||
    argv.includes('--live-harness-debug') ||
    argv.includes('--qwen-live-harness-debug')
  );
}
