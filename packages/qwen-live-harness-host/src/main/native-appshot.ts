import { createRequire } from 'node:module';
import { join } from 'node:path';

export type NativeAppshotPermissions = {
  accessibility: boolean;
  screenRecording: boolean;
};

export type NativeAppshotCapture = {
  appName: string;
  bundleIdentifier?: string;
  windowTitle?: string;
  windowId: number;
  accessibilityText: string;
  screenshot: Uint8Array;
};

export type NativeDisplay = {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
};

export type NativeDisplayCapture = {
  displayId: string;
  screenshot: Uint8Array;
  /** Required acknowledgement when native-resolution capture was requested. */
  nativeResolution?: true;
};

export type NativeAppshot = {
  getPermissionState: () => NativeAppshotPermissions;
  requestAccessibility: () => boolean;
  requestScreenRecording: () => boolean;
  captureAppshot: () => Promise<NativeAppshotCapture>;
  listDisplays: () => NativeDisplay[];
  captureDisplay: (
    displayId: string,
    nativeResolution?: boolean,
  ) => Promise<NativeDisplayCapture>;
};

let loaded: NativeAppshot | undefined;
const moduleDirectory =
  typeof __dirname === 'string'
    ? __dirname
    : join(process.cwd(), 'src', 'main');
const require = createRequire(join(moduleDirectory, 'main.cjs'));

function addonPath(): string {
  const { app } = require('electron') as typeof import('electron');
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'qwen-live-harness-appshot.node')
    : join(moduleDirectory, 'native', 'qwen-live-harness-appshot.node');
}

export function loadNativeAppshot(): NativeAppshot {
  if (loaded) return loaded;
  loaded = require(addonPath()) as NativeAppshot;
  return loaded;
}
