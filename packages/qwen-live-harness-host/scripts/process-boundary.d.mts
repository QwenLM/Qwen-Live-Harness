export function hostProcessBoundary(options?: {
  allowDaemonStartup?: boolean;
}): import('esbuild').Plugin;
export function rendererProcessBoundary(): import('vite').Plugin;
