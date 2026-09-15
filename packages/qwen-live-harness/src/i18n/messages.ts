/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type LiveLanguage = 'en' | 'zh-CN';

// Edit all fixed Qwen Live Harness display text here. Keep placeholders in sync.
export const LIVE_MESSAGES = {
  'language.choose': {
    en: 'Language / 语言 (← 简体中文 · English →, Enter / 回车)',
    'zh-CN': 'Language / 语言 (← 简体中文 · English →, Enter / 回车)',
  },
  'language.english': { en: 'English', 'zh-CN': 'English' },
  'language.chinese': { en: '简体中文', 'zh-CN': '简体中文' },
  'language.label': { en: 'Language', 'zh-CN': '语言' },
  // THEME_MESSAGES
  'theme.label': { en: 'Theme', 'zh-CN': '主题' },
  'theme.system': { en: 'System', 'zh-CN': '跟随系统' },
  'theme.light': { en: 'Light mode', 'zh-CN': '白天模式' },
  'theme.dark': { en: 'Dark mode', 'zh-CN': '黑暗模式' },
  'host.theme.invalid': {
    en: 'Invalid theme setting.',
    'zh-CN': '无效的主题设置。',
  },
  'host.theme.unavailable': {
    en: 'Theme settings are unavailable while Qwen Live Harness is quitting.',
    'zh-CN': 'Qwen Live Harness 正在退出，暂时无法修改主题。',
  },
  'host.theme.saveFailed': {
    en: 'Could not save the theme preference.',
    'zh-CN': '无法保存主题偏好。',
  },
  'ui.appName': { en: 'Qwen Live Harness', 'zh-CN': 'Qwen Live Harness' },
  'ui.screen': { en: 'Screen', 'zh-CN': '屏幕' },
  'ui.camera': { en: 'Camera', 'zh-CN': '摄像头' },
  'ui.onDemand': { en: 'On Demand', 'zh-CN': '按需截图' },
  'ui.liveFeed': { en: 'Live Feed', 'zh-CN': '实时画面' },
  'ui.audioSource': { en: 'Audio Source', 'zh-CN': '音频来源' },
  'ui.videoSource': { en: 'Video Source', 'zh-CN': '视频来源' },
  'ui.captureMode': { en: 'Capture Mode', 'zh-CN': '获取模式' },
  'ui.settings': { en: 'Settings', 'zh-CN': '设置' },
  'ui.openConfig': {
    en: 'Open config.json ↗',
    'zh-CN': '打开 config.json ↗',
  },
  'ui.openingConfig': { en: 'Opening editor…', 'zh-CN': '正在打开编辑器…' },
  'ui.openConfigHint': {
    en: 'Open in your default editor. Save, then restart Qwen Live Harness to apply file edits.',
    'zh-CN':
      '使用默认编辑器打开。保存后重启 Qwen Live Harness，以应用文件中的修改。',
  },
  'ui.close': { en: 'Close', 'zh-CN': '关闭' },
  'ui.closeSettings': { en: 'Close settings', 'zh-CN': '关闭设置' },
  'ui.quit': { en: 'Quit Host', 'zh-CN': '退出 Qwen Live Harness' },
  'ui.controls': {
    en: 'Qwen Live Harness controls',
    'zh-CN': 'Qwen Live Harness 控制',
  },
  'ui.toolbar': { en: 'Qwen Live Harness controls', 'zh-CN': '语音控制' },
  'ui.dragHint': {
    en: 'Drag to move · Hover for controls',
    'zh-CN': '拖动以移动 · 悬停显示控制',
  },
  'ui.muteInput': { en: 'Mute microphone', 'zh-CN': '麦克风静音' },
  'ui.unmuteInput': { en: 'Unmute microphone', 'zh-CN': '取消麦克风静音' },
  'ui.muteOutput': { en: 'Mute voice output', 'zh-CN': '播报静音' },
  'ui.unmuteOutput': { en: 'Unmute voice output', 'zh-CN': '取消播报静音' },
  'ui.micOff': { en: 'Mic off', 'zh-CN': '麦克风已关闭' },
  'ui.speakerMuted': { en: 'Speaker muted', 'zh-CN': '播报已静音' },
  'ui.micAndSpeakerMuted': {
    en: 'Mic off · Speaker muted',
    'zh-CN': '麦克风已关闭 · 播报已静音',
  },
  'ui.startCall': { en: 'Start call', 'zh-CN': '开始通话' },
  'ui.endCall': { en: 'End call', 'zh-CN': '结束通话' },
  'ui.shortcutAction': {
    en: '{action} ({shortcut})',
    'zh-CN': '{action}（{shortcut}）',
  },
  'ui.openPermission': {
    en: 'Open permission request',
    'zh-CN': '打开权限请求',
  },
  'ui.hidePreview': { en: 'Hide camera preview', 'zh-CN': '隐藏摄像头预览' },
  'ui.showPreview': { en: 'Show camera preview', 'zh-CN': '显示摄像头预览' },
  'ui.previewConnecting': {
    en: 'Connecting camera…',
    'zh-CN': '正在连接摄像头…',
  },
  'ui.cameraConnecting': {
    en: 'Camera · Connecting',
    'zh-CN': '摄像头 · 连接中',
  },
  'ui.cameraBadge': { en: 'Camera · {mode}', 'zh-CN': '摄像头 · {mode}' },
  'ui.localPreview': { en: 'Local preview', 'zh-CN': '本地预览' },
  'ui.setupHint': {
    en: 'Choose what Qwen Live Harness can see. Only the selected source needs permission.',
    'zh-CN': '选择 Qwen Live Harness 可见的内容，只需授权当前来源。',
  },
  'ui.microphone': { en: 'Microphone', 'zh-CN': '麦克风' },
  'ui.accessibility': { en: 'Accessibility', 'zh-CN': '辅助功能' },
  'ui.screenRecording': { en: 'Screen recording', 'zh-CN': '屏幕录制' },
  'ui.allow': { en: 'Allow', 'zh-CN': '授权' },
  'ui.allowMicrophone': { en: 'Allow microphone', 'zh-CN': '授权麦克风' },
  'ui.allowCamera': { en: 'Allow camera', 'zh-CN': '授权摄像头' },
  'ui.allowAccessibility': {
    en: 'Allow accessibility',
    'zh-CN': '授权辅助功能',
  },
  'ui.allowScreenRecording': {
    en: 'Allow screen recording',
    'zh-CN': '授权屏幕录制',
  },
  'ui.allowed': { en: 'Allowed', 'zh-CN': '已授权' },
  'ui.required': { en: 'Required', 'zh-CN': '需要授权' },
  'ui.connecting': {
    en: 'Connecting to Qwen Live Harness…',
    'zh-CN': '正在连接 Qwen Live Harness…',
  },
  'ui.waiting': {
    en: 'Waiting for Qwen Live Harness…',
    'zh-CN': '等待 Qwen Live Harness…',
  },
  'ui.allowRequired': {
    en: 'Allow the required permissions to start Qwen Live Harness.',
    'zh-CN': '请完成所需授权以开始使用 Qwen Live Harness。',
  },
  'ui.quitting': {
    en: 'Quitting Qwen Live Harness…',
    'zh-CN': '正在退出 Qwen Live Harness…',
  },
  'ui.quitFailed': {
    en: 'Could not shut down Qwen Live Harness. Please retry Quit.',
    'zh-CN': '未能完成退出，请再次点击退出。',
  },
  'ui.ready': {
    en: 'Ready · Hover for controls',
    'zh-CN': '已就绪 · 悬停显示控制',
  },
  'ui.starting': { en: 'Starting…', 'zh-CN': '正在开始…' },
  'ui.listening': { en: 'Listening', 'zh-CN': '聆听中' },
  'ui.thinking': { en: 'Thinking…', 'zh-CN': '思考中…' },
  'ui.speaking': { en: 'Speaking', 'zh-CN': '播报中' },
  'ui.stopping': { en: 'Ending call…', 'zh-CN': '正在结束通话…' },
  'ui.callEnded': { en: 'Call ended', 'zh-CN': '通话已结束' },
  'ui.unavailable': { en: 'Unavailable', 'zh-CN': '暂不可用' },
  'ui.refresh': { en: 'Refresh', 'zh-CN': '刷新' },
  'ui.refreshAudio': { en: 'Refresh audio sources', 'zh-CN': '刷新音频来源' },
  'ui.systemDefault': { en: 'System default', 'zh-CN': '系统默认' },
  'ui.display': { en: 'Display', 'zh-CN': '显示器' },
  'ui.displayCaptureUnavailable': {
    en: 'Display selection requires an up-to-date Qwen Live Harness daemon and Host.',
    'zh-CN': '请更新 Qwen Live Harness daemon 和 Host，以启用显示器选择。',
  },
  'ui.primaryDisplay': { en: 'Primary display', 'zh-CN': '主显示器' },
  'ui.displayMissing': {
    en: 'Unavailable display ({id})',
    'zh-CN': '显示器不可用（{id}）',
  },
  'ui.displayCaptureHint': {
    en: 'Monitor and Live Feed capture the entire selected display, excluding Qwen Live Harness Host windows. Appshot still captures the foreground application window.',
    'zh-CN':
      'Monitor 和实时画面会采集所选显示器的完整画面，但不包含 Qwen Live Harness Host 窗口。Appshot 仍截取前台应用窗口。',
  },
  'host.error.displayUnavailable': {
    en: 'The selected display is unavailable. Reconnect it or choose another display.',
    'zh-CN': '所选显示器不可用，请重新连接或选择其他显示器。',
  },
  'host.error.displayCapture': {
    en: 'Could not capture the selected display.',
    'zh-CN': '无法采集所选显示器画面。',
  },
  'host.error.displayList': {
    en: 'Could not list connected displays.',
    'zh-CN': '无法获取已连接的显示器。',
  },
  'runtime.displayCaptureUnsupported': {
    en: 'Update Qwen Live Harness Host to enable full-display capture.',
    'zh-CN': '请更新 Qwen Live Harness Host 以启用完整显示器采集。',
  },
  'runtime.displayCaptureMismatch': {
    en: 'The captured display does not match the selection.',
    'zh-CN': '采集的显示器与所选显示器不一致。',
  },
  'runtime.displaySaveFailed': {
    en: 'Could not save the selected display. The previous selection is unchanged.',
    'zh-CN': '无法保存显示器选择，已保留原设置。',
  },
  'ui.modeFeedHint': {
    en: 'Live Feed sends frames from the selected video source continuously during a call, at your configured FPS and resolution.',
    'zh-CN':
      '实时画面会在通话期间，以配置的帧率和分辨率持续发送所选视频来源的画面。',
  },
  'ui.modeDemandHint': {
    en: 'On Demand lets the foreground model request an Appshot snapshot from the selected video source when visual context is needed.',
    'zh-CN':
      '按需截图会在前台模型需要视觉信息时，通过 Appshot 获取所选视频来源的截图。',
  },
  'ui.modeUnavailable': {
    en: 'Video capture settings are unavailable for this connection.',
    'zh-CN': '当前连接不支持视频获取设置。',
  },
  'ui.applying': { en: 'Applying…', 'zh-CN': '正在应用…' },
  'ui.loadingDevices': {
    en: 'Loading input devices…',
    'zh-CN': '正在加载输入设备…',
  },
  'ui.memory': { en: 'Memory', 'zh-CN': '记忆' },
  'ui.memoryEnable': { en: 'Enable memory', 'zh-CN': '启用记忆' },
  'ui.memoryVisual': { en: 'Visual memory', 'zh-CN': '视觉记忆' },
  'ui.memoryVisualHint': {
    en: 'Visual memory records observations from the selected Screen or Camera.',
    'zh-CN': '视觉记忆会记录从所选屏幕或摄像头画面中观察到的内容。',
  },
  'ui.memoryLibrary': { en: 'Memory library', 'zh-CN': '记忆库' },
  'ui.memoryNew': { en: 'New', 'zh-CN': '新建' },
  'ui.memoryRename': { en: 'Rename', 'zh-CN': '重命名' },
  'ui.save': { en: 'Save', 'zh-CN': '保存' },
  'ui.cancel': { en: 'Cancel', 'zh-CN': '取消' },
  'ui.saveModel': { en: 'Save model', 'zh-CN': '保存模型' },
  'ui.memoryModel': { en: 'Consolidation model', 'zh-CN': '记忆整理模型' },
  'ui.newLibraryName': { en: 'New library name', 'zh-CN': '新记忆库名称' },
  'ui.renameLibrary': { en: 'Rename library', 'zh-CN': '重命名记忆库' },
  'ui.memoryLockedHint': {
    en: 'End the current call to select or create a library, or change the model. You can rename a library now.',
    'zh-CN':
      '请先结束当前通话，再选择或新建记忆库、修改模型；通话中仍可重命名。',
  },
  'ui.memorySavedHint': {
    en: 'Library selection and settings are saved for your next call.',
    'zh-CN': '记忆库选择和设置会保存，并在后续通话中使用。',
  },
  'ui.memoryConnectHint': {
    en: 'Connect to Qwen Live Harness to change memory settings.',
    'zh-CN': '请先连接 Qwen Live Harness，再修改记忆设置。',
  },
  'ui.saving': { en: 'Saving…', 'zh-CN': '正在保存…' },
  // HOST_UI_MESSAGES
  'init.title': {
    en: 'qwen-live-harness setup',
    'zh-CN': 'qwen-live-harness 初始化',
  },
  'init.overwrite': {
    en: 'A config.json already exists. Overwrite?',
    'zh-CN': 'config.json 已存在，要覆盖吗？',
  },
  'init.keep': {
    en: 'Keeping existing config. Run `qwen-live-harness` to start.',
    'zh-CN': '已保留现有配置。运行 `qwen-live-harness` 启动。',
  },
  'init.scanning': {
    en: 'Scanning for installed coding agents...',
    'zh-CN': '正在查找已安装的编程代理…',
  },
  'init.noAgents': {
    en: 'No supported coding agents found on your PATH.',
    'zh-CN': '在 PATH 中没有找到支持的编程代理。',
  },
  'init.installAgent': {
    en: 'Install at least one of: qodercli, qwen, gemini, claude, codex',
    'zh-CN': '请至少安装一个：qodercli、qwen、gemini、claude、codex',
  },
  'init.manualConfig': {
    en: 'You can create {path} manually instead.',
    'zh-CN': '也可以手动创建 {path}。',
  },
  'init.defaultAgent': {
    en: 'Which agent should be the default backend?',
    'zh-CN': '选择默认的编程代理：',
  },
  'init.cancelled': { en: 'Cancelled.', 'zh-CN': '已取消。' },
  'init.addAgent': {
    en: 'Add another backend? ({count} remaining)',
    'zh-CN': '要添加其他编程代理吗？（还有 {count} 个）',
  },
  'init.whichAgent': { en: 'Which agent?', 'zh-CN': '选择编程代理：' },
  'init.useEnv': {
    en: 'Use {name} from the environment?',
    'zh-CN': '使用环境变量 {name} 中的 API key 吗？',
  },
  'init.unsetEnv': {
    en: 'Note: unset {name} before starting qwen-live-harness; environment variables override config.json.',
    'zh-CN':
      '提示：启动 qwen-live-harness 前请取消设置 {name}；环境变量会覆盖 config.json。',
  },
  'init.apiKey': {
    en: 'DashScope realtime API key (sk-...):',
    'zh-CN': 'DashScope 实时 API key（sk-...）：',
  },
  'init.apiKeyRequired': {
    en: 'Please enter your API key',
    'zh-CN': '请输入 API key',
  },
  'init.cancelledKey': {
    en: 'Cancelled — API key is required.',
    'zh-CN': '已取消：API key 不能为空。',
  },
  'init.apiName': {
    en: 'DashScope Realtime API name:',
    'zh-CN': 'DashScope Realtime API 模型名：',
  },
  'init.apiNameRequired': {
    en: 'Please enter an API name',
    'zh-CN': '请输入 API 模型名',
  },
  'init.memoryEnabled': {
    en: 'Enable Memory for cross-call recall?',
    'zh-CN': '启用 Memory 以便在通话之间保留记忆吗？',
  },
  'init.memoryModel': {
    en: 'DashScope Memory consolidation model:',
    'zh-CN': 'DashScope 记忆整理模型：',
  },
  'init.modelRequired': {
    en: 'Please enter a valid model name',
    'zh-CN': '请输入有效的模型名',
  },
  'init.cwd': {
    en: 'Default working directory for coding sessions:',
    'zh-CN': '编程会话的默认工作目录：',
  },
  'init.hostChecking': {
    en: 'Checking Qwen Live Harness Host app...',
    'zh-CN': '正在检查 Qwen Live Harness Host 应用…',
  },
  'init.hostInstalled': {
    en: 'Qwen Live Harness Host {version} is installed.',
    'zh-CN': '已安装 Qwen Live Harness Host {version}。',
  },
  'init.hostInstall': {
    en: 'Qwen Live Harness Host is not installed. Install now?',
    'zh-CN': '尚未安装 Qwen Live Harness Host，现在安装吗？',
  },
  'init.hostInstalling': {
    en: 'Installing Qwen Live Harness Host (this may take a minute)...',
    'zh-CN': '正在安装 Qwen Live Harness Host（可能需要一分钟）…',
  },
  'init.hostInstallFailed': {
    en: 'Installation failed: {detail}',
    'zh-CN': '安装失败：{detail}',
  },
  'init.hostCheckFailed': {
    en: 'Host check failed: {detail}',
    'zh-CN': 'Host 检查失败：{detail}',
  },
  'init.hostMacOnly': {
    en: 'Qwen Live Harness Host app is macOS-only. Voice features require a Mac.',
    'zh-CN': 'Qwen Live Harness Host 仅支持 macOS；语音功能需要 Mac。',
  },
  'init.unknownError': { en: 'unknown error', 'zh-CN': '未知错误' },
  'init.saved': {
    en: 'Config written to {path}',
    'zh-CN': '配置已写入 {path}',
  },
  'init.backendSummary': {
    en: 'Default backend: {name}',
    'zh-CN': '默认编程代理：{name}',
  },
  'init.apiSummary': {
    en: 'Realtime API: {name}',
    'zh-CN': 'Realtime API：{name}',
  },
  'init.memorySummary': { en: 'Memory: {name}', 'zh-CN': '记忆：{name}' },
  'init.hostSummary': { en: 'Host: {status}', 'zh-CN': 'Host：{status}' },
  'init.run': {
    en: 'Setup is complete. Run `qwen-live-harness` or open Qwen Live Harness Host to start. Setup itself does not start a call.',
    'zh-CN':
      '初始化已完成。运行 `qwen-live-harness` 或打开 Qwen Live Harness Host 即可启动；初始化本身不会开始通话。',
  },
  'init.disabled': { en: 'disabled', 'zh-CN': '已关闭' },
  'init.hostSkipped': { en: 'skipped', 'zh-CN': '已跳过' },
  'init.hostReady': { en: 'installed', 'zh-CN': '已安装' },
  'init.hostFailed': { en: 'failed', 'zh-CN': '安装失败' },
  'init.hostError': { en: 'error', 'zh-CN': '检查失败' },
  'init.hostUnsupported': { en: 'unsupported', 'zh-CN': '不支持' },
  'init.yes': { en: 'yes', 'zh-CN': '是' },
  'init.no': { en: 'no', 'zh-CN': '否' },
  'init.yesOption': { en: '(Y/n)', 'zh-CN': '（Y 是 / n 否）' },
  'init.noOption': { en: '(y/N)', 'zh-CN': '（y 是 / N 否）' },
  'init.selectHint': {
    en: '- Use arrow-keys. Return to submit.',
    'zh-CN': '- 使用方向键选择，回车确认。',
  },
  'init.selectDisabled': {
    en: '- This option is disabled',
    'zh-CN': '- 此选项不可用',
  },
  // INIT_MESSAGES
  'cli.debugNotice': {
    en: 'Debug enabled. Foreground diagnostics omit media and credentials, but visual Monitor archives contain real screen/camera frames, audio and prompt/response text. The archive directory is logged when ready; review recordings before sharing.',
    'zh-CN':
      '已开启 debug。前台诊断日志省略媒体和连接凭据，但视觉 Monitor 归档包含真实屏幕／摄像头画面、音频和提示词／回复文本。归档就绪后会打印目录；分享前请检查敏感内容。',
  },
  'cli.usage': {
    en: 'Usage: qwen-live-harness [init] [--debug]\n\nStart or reuse the daemon and open the desktop Host.\n\nOptions:\n  --debug, -d  Print diagnostics; save sensitive visual Monitor archives\n  --daemon-only  Run the daemon without opening Host (development)\n  --help, -h   Show this help',
    'zh-CN':
      '用法：qwen-live-harness [init] [--debug]\n\n启动或复用服务，并打开桌面 Host。\n\n选项：\n  --debug, -d  输出诊断日志，并保存含敏感内容的视觉 Monitor 归档\n  --daemon-only  仅运行服务，不打开 Host（开发调试）\n  --help, -h   显示帮助',
  },
  'cli.reused': {
    en: 'Connected to the running Qwen Live Harness daemon.',
    'zh-CN': '已复用正在运行的 Qwen Live Harness 服务。',
  },
  'cli.hostOpened': {
    en: 'Qwen Live Harness Host is opening.',
    'zh-CN': '正在打开 Qwen Live Harness Host。',
  },
  'startup.connecting': {
    en: 'Starting Qwen Live Harness…',
    'zh-CN': '正在启动 Qwen Live Harness…',
  },
  'startup.retry': {
    en: 'Retry startup',
    'zh-CN': '重试启动',
  },
  'startup.runtime_missing': {
    en: 'Desktop startup has not been configured. Run qwen-live-harness init in a terminal, then reopen this app.',
    'zh-CN':
      '尚未配置桌面启动。请在终端运行 qwen-live-harness init，再重新打开应用。',
  },
  'startup.runtime_invalid': {
    en: 'Desktop startup information is invalid. Run qwen-live-harness in a terminal to refresh it.',
    'zh-CN':
      '桌面启动信息无效。请在终端运行 qwen-live-harness 以更新启动信息。',
  },
  'startup.runtime_unavailable': {
    en: 'The installed Node.js or CLI could not be found or is incompatible. Reinstall qwen-live-harness and run it once in a terminal.',
    'zh-CN':
      '找不到已安装的 Node.js 或 CLI，或版本不兼容。请重新安装 qwen-live-harness，并在终端运行一次。',
  },
  'startup.config_missing': {
    en: 'Configuration is missing. Run qwen-live-harness init in a terminal first.',
    'zh-CN': '缺少配置，请先在终端运行 qwen-live-harness init。',
  },
  'startup.discovery_invalid': {
    en: 'The local daemon connection record is invalid. Close Qwen Live Harness and run it again in a terminal.',
    'zh-CN': '本地服务连接记录无效。请关闭 Qwen Live Harness，再从终端启动。',
  },
  'startup.daemon_unresponsive': {
    en: 'The daemon is not responding. Check its terminal or startup log. Use Retry startup in the menu bar, or quit and reopen this app.',
    'zh-CN':
      '服务没有响应。请检查其终端或启动日志；可在菜单栏选择“重试启动”，或退出后重新打开应用。',
  },
  'startup.daemon_mismatch': {
    en: 'The running daemon and Host do not match. Quit the running application, then start matching versions.',
    'zh-CN': '当前服务与 Host 不匹配。请退出正在运行的应用，再启动配套版本。',
  },
  'startup.daemon_start_failed': {
    en: 'The daemon could not start. Check the startup log or run qwen-live-harness in a terminal for details, then reopen this app to retry.',
    'zh-CN':
      '服务启动失败。请检查启动日志，或在终端运行 qwen-live-harness 查看原因，再重新打开应用重试。',
  },
  'startup.startup_timeout': {
    en: 'Daemon startup timed out. Check the startup log, then reopen this app to retry.',
    'zh-CN': '服务启动超时。请检查启动日志，再重新打开应用重试。',
  },
  'startup.startup_aborted': {
    en: 'Startup was cancelled.',
    'zh-CN': '启动已取消。',
  },
  'startup.startup_cleanup_failed': {
    en: 'The starting daemon could not be stopped. Retry Quit before starting again.',
    'zh-CN': '未能停止正在启动的服务。请重试退出，再重新启动。',
  },
  'startup.startup_busy': {
    en: 'Another startup is still in progress. Wait for it to finish, then retry.',
    'zh-CN': '另一次启动仍在进行中，请等待完成后重试。',
  },
  'startup.invalidDiscoveryPath': {
    en: 'The desktop launch path is invalid. Run qwen-live-harness init again.',
    'zh-CN': '桌面启动路径无效，请重新运行 qwen-live-harness init。',
  },
  'startup.profileMismatch': {
    en: 'Host is already using another configuration. Quit it before opening this one.',
    'zh-CN': 'Host 正在使用另一份配置。请先退出，再打开当前配置。',
  },
  'installer.versionMismatch': {
    en: 'Qwen Live Harness Host version {installed} does not match CLI version {required}. Install matching Host and CLI versions.',
    'zh-CN':
      'Qwen Live Harness Host 版本 {installed} 与 CLI 版本 {required} 不匹配，请安装配套版本。',
  },
  'cli.unknownArgument': {
    en: 'Unknown qwen-live-harness argument: {argument}',
    'zh-CN': '未知的 qwen-live-harness 参数：{argument}',
  },
  'language.invalid': {
    en: 'Language must be en or zh-CN.',
    'zh-CN': '语言必须是 en 或 zh-CN。',
  },
  'language.configInvalid': {
    en: 'Qwen Live Harness configuration must be an object.',
    'zh-CN': 'Qwen Live Harness 配置必须是对象。',
  },
  'language.saveFailed': {
    en: 'Could not save the language preference.',
    'zh-CN': '无法保存语言设置。',
  },
  'language.unavailable': {
    en: 'Language settings are unavailable in this daemon.',
    'zh-CN': '当前服务不支持语言设置。',
  },
  'language.callChanged': {
    en: 'The Qwen Live Harness call changed. Retry the language setting.',
    'zh-CN': 'Qwen Live Harness 通话已变化，请重试语言设置。',
  },
  'runtime.hostMissing': {
    en: 'Qwen Live Harness Host is not connected.',
    'zh-CN': '尚未连接 Qwen Live Harness Host。',
  },
  'runtime.hostDisconnected': {
    en: 'Qwen Live Harness Host disconnected.',
    'zh-CN': 'Qwen Live Harness Host 已断开。',
  },
  'runtime.hostVersion': {
    en: 'Qwen Live Harness Host is not protocol-compatible.',
    'zh-CN': 'Qwen Live Harness Host 的协议版本不兼容。',
  },
  'runtime.microphonePermission': {
    en: 'Microphone permission is required.',
    'zh-CN': '需要麦克风权限。',
  },
  'runtime.cameraPermission': {
    en: 'Camera permission is required.',
    'zh-CN': '需要摄像头权限。',
  },
  'runtime.accessibilityPermission': {
    en: 'Accessibility permission is required.',
    'zh-CN': '需要辅助功能权限。',
  },
  'runtime.screenPermission': {
    en: 'Screen Recording permission is required.',
    'zh-CN': '需要屏幕录制权限。',
  },
  'runtime.audioInput': {
    en: 'Qwen Live Harness Host audio input self-check failed.',
    'zh-CN': 'Qwen Live Harness Host 音频输入自检失败。',
  },
  'runtime.audioOutput': {
    en: 'Qwen Live Harness Host audio output self-check failed.',
    'zh-CN': 'Qwen Live Harness Host 音频输出自检失败。',
  },
  'runtime.shortcut': {
    en: 'Qwen Live Harness Host global shortcut self-check failed.',
    'zh-CN': 'Qwen Live Harness Host 全局快捷键自检失败。',
  },
  'runtime.appshot': {
    en: 'Appshot self-check failed.',
    'zh-CN': 'Appshot 截图自检失败。',
  },
  'runtime.appshotUnchecked': {
    en: 'The dedicated Appshot channel has not been verified.',
    'zh-CN': '尚未验证 Appshot 截图通道。',
  },
  'runtime.providerConfig': {
    en: 'Qwen Live Harness provider configuration is invalid.',
    'zh-CN': 'Qwen Live Harness 模型服务配置无效。',
  },
  'runtime.providerUnavailable': {
    en: 'The Qwen Live Harness provider is unreachable.',
    'zh-CN': '无法连接 Qwen Live Harness 模型服务。',
  },
  'runtime.apiKeyMissing': {
    en: 'DashScope realtime API key is not configured.',
    'zh-CN': '尚未配置 DashScope 实时 API key。',
  },
  'runtime.startFailed': {
    en: 'Qwen Live Harness voice failed to start.',
    'zh-CN': 'Qwen Live Harness 语音启动失败。',
  },
  'runtime.callFailed': {
    en: 'Qwen Live Harness voice failed.',
    'zh-CN': 'Qwen Live Harness 语音运行失败。',
  },
  'runtime.audioDropped': {
    en: 'Qwen Live Harness voice audio transport dropped input.',
    'zh-CN': 'Qwen Live Harness 语音传输丢失了输入音频。',
  },
  'runtime.audioInputFailed': {
    en: 'Qwen Live Harness voice audio input failed.',
    'zh-CN': 'Qwen Live Harness 语音输入失败。',
  },
  'runtime.stopFailed': {
    en: 'Qwen Live Harness voice failed to stop safely.',
    'zh-CN': 'Qwen Live Harness 语音未能安全停止。',
  },
  'runtime.finalInputCommit': {
    en: 'Qwen Live Harness voice could not commit the final spoken input.',
    'zh-CN': 'Qwen Live Harness 语音无法提交最后一段语音输入。',
  },
  'runtime.finalInputTimeout': {
    en: 'Qwen Live Harness voice could not confirm the final spoken input before the stop deadline.',
    'zh-CN': 'Qwen Live Harness 语音停止前未能及时确认最后一段输入。',
  },
  'runtime.realtimeConnect': {
    en: 'Qwen Live Harness voice could not connect.',
    'zh-CN': '无法连接 Qwen Live Harness 语音。',
  },
  'runtime.realtimeFailed': {
    en: 'Qwen Live Harness voice failed.{detail}',
    'zh-CN': 'Qwen Live Harness 语音运行失败。{detail}',
  },
  'runtime.realtimeDisconnected': {
    en: 'Qwen Live Harness voice disconnected.{detail}',
    'zh-CN': 'Qwen Live Harness 语音已断开。{detail}',
  },
  'runtime.realtimeConnectDetail': {
    en: 'Qwen Live Harness voice could not connect.{detail}',
    'zh-CN': '无法连接 Qwen Live Harness 语音。{detail}',
  },
  'runtime.realtimeAuth': {
    en: 'Realtime authentication failed: {detail} Replace or unset DASHSCOPE_API_KEY/QWEN_LIVE_HARNESS_REALTIME_API_KEY (environment variables override config.json), then restart qwen-live-harness.',
    'zh-CN':
      'Realtime 身份验证失败：{detail} 请更换或取消设置 DASHSCOPE_API_KEY/QWEN_LIVE_HARNESS_REALTIME_API_KEY（环境变量会覆盖 config.json），然后重启 qwen-live-harness。',
  },
  'runtime.realtimeConfig': {
    en: 'Realtime configuration failed: {detail} Run qwen-live-harness init, then restart qwen-live-harness.',
    'zh-CN':
      'Realtime 配置失败：{detail} 请运行 qwen-live-harness init，然后重启 qwen-live-harness。',
  },
  'runtime.invalidKey': { en: 'invalid API key.', 'zh-CN': 'API key 无效。' },
  'runtime.invalidSettings': { en: 'invalid settings.', 'zh-CN': '设置无效。' },
  'runtime.toolResultFailed': {
    en: 'Qwen Live Harness voice could not return a tool result.',
    'zh-CN': 'Qwen Live Harness 语音无法返回工具结果。',
  },
  'memoryUI.closed': {
    en: 'Memory service is closed.',
    'zh-CN': 'Memory 服务已关闭。',
  },
  'memoryUI.locked': {
    en: 'End the current call before changing the memory library or model.',
    'zh-CN': '请先结束当前通话，再切换记忆库或模型。',
  },
  'memoryUI.unsupported': {
    en: 'Unsupported Memory action.',
    'zh-CN': '不支持此 Memory 操作。',
  },
  'memoryUI.callChanged': {
    en: 'The Qwen Live Harness call changed. Retry the Memory action.',
    'zh-CN': 'Qwen Live Harness 通话已变化，请重试 Memory 操作。',
  },
  'memoryUI.unavailable': {
    en: 'Memory is unavailable in this daemon.',
    'zh-CN': '当前服务不支持 Memory。',
  },
  'memoryUI.stateUnavailable': {
    en: 'Memory state is unavailable.',
    'zh-CN': '无法获取 Memory 状态。',
  },
  'memoryUI.pending': {
    en: 'Too many pending Memory requests.',
    'zh-CN': '等待中的 Memory 请求过多。',
  },
  'memoryUI.updateFailed': {
    en: 'Could not update Memory settings.',
    'zh-CN': '无法更新 Memory 设置。',
  },
  'memoryUI.fallback': {
    en: 'Selected memory is unavailable; using Default Memory.',
    'zh-CN': '所选记忆库不可用，已使用默认记忆库。',
  },
  'memoryUI.budget': {
    en: 'Stored memory exceeds the available prompt budget. Reduce its size or configured limits.',
    'zh-CN': '已存记忆超出提示词容量，请缩减记忆或配置的上限。',
  },
  'memoryUI.storage': {
    en: 'Memory storage is unavailable. Check its directory and permissions.',
    'zh-CN': '记忆存储不可用，请检查目录和访问权限。',
  },
  'memoryUI.id': {
    en: 'Memory library id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}',
    'zh-CN': '记忆库 ID 必须符合 [A-Za-z0-9][A-Za-z0-9_-]{0,63}',
  },
  'memoryUI.nameText': {
    en: 'Memory name must be text',
    'zh-CN': '记忆库名称必须是文本',
  },
  'memoryUI.name': {
    en: 'Memory name must contain 1–80 characters without control characters',
    'zh-CN': '记忆库名称应为 1–80 个字符，不能包含控制字符',
  },
  'memoryUI.file': {
    en: 'Memory data must be a regular file',
    'zh-CN': '记忆数据必须是普通文件',
  },
  'memoryUI.storeClosed': {
    en: 'Memory store is closed',
    'zh-CN': '记忆存储已关闭',
  },
  'memoryUI.missing': {
    en: 'Memory library does not exist',
    'zh-CN': '记忆库不存在',
  },
  'memoryUI.directory': {
    en: 'Memory library must be a regular directory',
    'zh-CN': '记忆库必须是普通目录',
  },
  'memoryUI.metaMissing': {
    en: 'Memory library metadata does not exist',
    'zh-CN': '记忆库元数据不存在',
  },
  'memoryUI.metaUnreadable': {
    en: 'Memory library metadata is unreadable',
    'zh-CN': '无法读取记忆库元数据',
  },
  'memoryUI.metaInvalid': {
    en: 'Memory library metadata is invalid',
    'zh-CN': '记忆库元数据无效',
  },
  'memoryUI.exists': {
    en: 'Memory library already exists',
    'zh-CN': '记忆库已存在',
  },
  'memoryUI.schema': {
    en: 'Unsupported memory schema version',
    'zh-CN': '不支持此记忆数据版本',
  },
  'runtime.realtimeAuthEmpty': {
    en: 'Realtime authentication failed: invalid API key. Replace or unset DASHSCOPE_API_KEY/QWEN_LIVE_HARNESS_REALTIME_API_KEY (environment variables override config.json), then restart qwen-live-harness.',
    'zh-CN':
      'Realtime 身份验证失败：API key 无效。请更换或取消设置 DASHSCOPE_API_KEY/QWEN_LIVE_HARNESS_REALTIME_API_KEY（环境变量会覆盖 config.json），然后重启 qwen-live-harness。',
  },
  'runtime.realtimeConfigEmpty': {
    en: 'Realtime configuration failed: invalid settings. Run qwen-live-harness init, then restart qwen-live-harness.',
    'zh-CN':
      'Realtime 配置失败：设置无效。请运行 qwen-live-harness init，然后重启 qwen-live-harness。',
  },
  'installer.architecture': {
    en: 'Qwen Live Harness Host is unavailable for architecture {architecture}.',
    'zh-CN': 'Qwen Live Harness Host 不支持 {architecture} 架构。',
  },
  'installer.assetInvalid': {
    en: 'Qwen Live Harness Host manifest asset is invalid.',
    'zh-CN': 'Qwen Live Harness Host 清单中的资源无效。',
  },
  'installer.manifestInvalid': {
    en: 'Qwen Live Harness Host manifest is invalid.',
    'zh-CN': 'Qwen Live Harness Host 安装清单无效。',
  },
  'installer.manifestIncompatible': {
    en: 'Qwen Live Harness Host manifest is incompatible.',
    'zh-CN': 'Qwen Live Harness Host 安装清单不兼容。',
  },
  'installer.bundleInvalid': {
    en: 'Qwen Live Harness Host installation is not a regular app bundle.',
    'zh-CN': 'Qwen Live Harness Host 安装目录不是正常应用包。',
  },
  'installer.identityInvalid': {
    en: 'Qwen Live Harness Host bundle identity is invalid.',
    'zh-CN': 'Qwen Live Harness Host 应用标识无效。',
  },
  'installer.versionInvalid': {
    en: 'Qwen Live Harness Host version is invalid.',
    'zh-CN': 'Qwen Live Harness Host 版本无效。',
  },
  'installer.signatureInvalid': {
    en: 'Qwen Live Harness Host signing identity is invalid.',
    'zh-CN': 'Qwen Live Harness Host 签名身份无效。',
  },
  'installer.manifestDownload': {
    en: 'Qwen Live Harness Host manifest download failed ({status}).',
    'zh-CN': 'Qwen Live Harness Host 清单下载失败（{status}）。',
  },
  'installer.downloadStatus': {
    en: 'Qwen Live Harness Host download failed ({status}).',
    'zh-CN': 'Qwen Live Harness Host 下载失败（{status}）。',
  },
  'installer.sizeMismatch': {
    en: 'Qwen Live Harness Host download size does not match its manifest.',
    'zh-CN': 'Qwen Live Harness Host 下载大小与清单不一致。',
  },
  'installer.sizeExceeded': {
    en: 'Qwen Live Harness Host download exceeded its manifest size.',
    'zh-CN': 'Qwen Live Harness Host 下载内容超出清单标注大小。',
  },
  'installer.checksum': {
    en: 'Qwen Live Harness Host checksum verification failed.',
    'zh-CN': 'Qwen Live Harness Host 文件校验失败。',
  },
  'installer.downloadFailed': {
    en: 'Qwen Live Harness Host download failed. {details}',
    'zh-CN': 'Qwen Live Harness Host 下载失败。{details}',
  },
  'installer.packageVersion': {
    en: 'Qwen Live Harness Host package version does not match its manifest.',
    'zh-CN': 'Qwen Live Harness Host 安装包版本与清单不一致。',
  },
  'installer.installedVersion': {
    en: 'Installed Qwen Live Harness Host version is invalid.',
    'zh-CN': '已安装的 Qwen Live Harness Host 版本无效。',
  },
  'installer.setupFailed': {
    en: 'Qwen Live Harness Host setup failed.',
    'zh-CN': 'Qwen Live Harness Host 安装失败。',
  },
  'installer.macOnly': {
    en: 'Qwen Live Harness Host is available only on macOS.',
    'zh-CN': 'Qwen Live Harness Host 仅支持 macOS。',
  },
  'installer.notInstalled': {
    en: 'Qwen Live Harness Host is not installed.',
    'zh-CN': '尚未安装 Qwen Live Harness Host。',
  },
  'installer.sourcesFailed': {
    en: 'Qwen Live Harness Host download failed. OSS: {oss}; GitHub: {github}',
    'zh-CN': 'Qwen Live Harness Host 下载失败。OSS：{oss}；GitHub：{github}',
  },
  'installer.protocol': {
    en: 'Qwen Live Harness Host protocol v{installed} is incompatible; v{required} is required.',
    'zh-CN':
      'Qwen Live Harness Host 协议 v{installed} 不兼容，需要 v{required}。',
  },
  // RUNTIME_MESSAGES
  // HOST_ERROR_MESSAGES
  'host.error.visualFailed': {
    en: 'Visual capture failed.',
    'zh-CN': '画面采集失败。',
  },
  'code.camera_transport_rejected': {
    en: 'The camera frame could not reach Qwen Live Harness.',
    'zh-CN': '摄像头画面未能送达 Qwen Live Harness。',
  },
  'code.screen_transport_rejected': {
    en: 'The screen frame could not reach Qwen Live Harness.',
    'zh-CN': '屏幕画面未能送达 Qwen Live Harness。',
  },
  'code.screen_failed': {
    en: 'Screen capture failed. Check permissions and try again.',
    'zh-CN': '屏幕采集失败，请检查权限后重试。',
  },
  'code.camera_snapshot_failed': {
    en: 'Camera snapshot failed. Please try again.',
    'zh-CN': '摄像头截图失败，请重试。',
  },
  'code.camera_preview_restore_failed': {
    en: 'Could not restore the camera preview after capture.',
    'zh-CN': '截图后无法恢复摄像头预览。',
  },
  'code.audio_unavailable': {
    en: 'Audio is unavailable. Check your devices and permissions.',
    'zh-CN': '音频不可用，请检查设备及权限。',
  },
  'code.camera_unavailable': {
    en: 'Camera is unavailable. Check your device and permissions.',
    'zh-CN': '摄像头不可用，请检查设备及权限。',
  },
  'code.NotAllowedError': {
    en: 'Device access was denied. Check system permissions.',
    'zh-CN': '设备访问被拒绝，请检查系统权限。',
  },
  'code.NotFoundError': {
    en: 'The requested device was not found.',
    'zh-CN': '未找到所需设备。',
  },
  'code.NotReadableError': {
    en: 'The device cannot be read. It may be in use.',
    'zh-CN': '无法读取设备，设备可能正被其他应用占用。',
  },
  'code.OverconstrainedError': {
    en: 'The device does not support these capture settings.',
    'zh-CN': '设备不支持这些采集设置。',
  },
  'code.AbortError': {
    en: 'The device operation was interrupted. Please try again.',
    'zh-CN': '设备操作已中断，请重试。',
  },
  'code.SecurityError': {
    en: 'Device access is blocked by the system.',
    'zh-CN': '设备访问被系统阻止。',
  },
  'code.host_version': {
    en: 'This Host version is incompatible. Update Qwen Live Harness Host.',
    'zh-CN': 'Host 版本不兼容，请更新 Qwen Live Harness Host。',
  },
  'code.daemon_identity': {
    en: 'Could not verify the Qwen Live Harness daemon identity.',
    'zh-CN': '无法验证 Qwen Live Harness 后台进程的身份。',
  },
  'code.daemon_connection': {
    en: 'Could not connect to Qwen Live Harness.',
    'zh-CN': '无法连接 Qwen Live Harness。',
  },
  'code.daemon_disconnected': {
    en: 'Qwen Live Harness disconnected.',
    'zh-CN': 'Qwen Live Harness 已断开连接。',
  },
  'code.daemon_reconnect_exhausted': {
    en: 'Could not reconnect to Qwen Live Harness. Restart Qwen Live Harness to try again.',
    'zh-CN':
      '无法重新连接 Qwen Live Harness，请重启 Qwen Live Harness 后重试。',
  },
  'code.camera_permission_required': {
    en: 'Camera permission is required.',
    'zh-CN': '需要摄像头权限。',
  },
  'code.camera_not_ready': {
    en: 'Camera is not ready.',
    'zh-CN': '摄像头尚未就绪。',
  },
  'code.camera_video_unavailable': {
    en: 'Camera video is unavailable.',
    'zh-CN': '无法读取摄像头画面。',
  },
  'code.camera_track_ended': {
    en: 'The camera was disconnected.',
    'zh-CN': '摄像头已断开。',
  },
  'code.camera_ready_timeout': {
    en: 'Camera startup timed out.',
    'zh-CN': '摄像头启动超时。',
  },
  'code.camera_snapshot_frame_timeout': {
    en: 'Timed out waiting for a camera frame.',
    'zh-CN': '等待摄像头画面超时。',
  },
  'code.camera_renderer_unavailable': {
    en: 'The camera renderer is unavailable.',
    'zh-CN': '摄像头界面暂不可用。',
  },
  'code.camera_snapshot_timeout': {
    en: 'Camera snapshot timed out.',
    'zh-CN': '摄像头截图超时。',
  },
  'code.camera_snapshot_resolution_unavailable': {
    en: 'The camera cannot capture the configured snapshot resolution.',
    'zh-CN': '摄像头无法按配置的分辨率截图。',
  },
  'code.camera_photo_resolution_unavailable': {
    en: 'The camera cannot capture a native-resolution photo.',
    'zh-CN': '摄像头无法拍摄原生分辨率照片。',
  },
  'code.camera_snapshot_asset_missing': {
    en: 'The camera snapshot could not be saved.',
    'zh-CN': '无法保存摄像头截图。',
  },
  'code.camera_capture_configuration_invalid': {
    en: 'Camera capture settings are invalid.',
    'zh-CN': '摄像头采集设置无效。',
  },
  'code.camera_snapshot_configuration_invalid': {
    en: 'Camera snapshot settings are invalid.',
    'zh-CN': '摄像头截图设置无效。',
  },
  'code.camera_not_in_on_demand_mode': {
    en: 'Select On Demand to take a snapshot.',
    'zh-CN': '请切换为按需截图模式。',
  },
  'code.camera_canvas_unavailable': {
    en: 'Could not prepare the camera image.',
    'zh-CN': '无法处理摄像头图片。',
  },
  'code.camera_frame_too_large': {
    en: 'The camera image is too large to send.',
    'zh-CN': '摄像头图片过大，无法发送。',
  },
  'code.screen_capture_unavailable': {
    en: 'Screen capture is unavailable. Check screen recording permission.',
    'zh-CN': '屏幕采集不可用，请检查屏幕录制权限。',
  },
  'code.screen_image_decode_failed': {
    en: 'Could not read the screen image.',
    'zh-CN': '无法读取屏幕图片。',
  },
  'code.screen_frame_too_large': {
    en: 'The screen image is too large to send.',
    'zh-CN': '屏幕图片过大，无法发送。',
  },
  'code.stale_visual_capture': {
    en: 'The source or call changed during capture. Try again.',
    'zh-CN': '采集过程中来源或通话已改变，请重试。',
  },
  'code.visual_settings_changed': {
    en: 'The video settings changed. Try capturing again.',
    'zh-CN': '视频设置已改变，请重新截图。',
  },
  'code.jpeg_encode_failed': {
    en: 'Could not encode the captured image.',
    'zh-CN': '无法编码所采集的图片。',
  },
  'code.jpeg_read_failed': {
    en: 'Could not read the captured image.',
    'zh-CN': '无法读取所采集的图片。',
  },
  'code.audio_service_inactive': {
    en: 'Audio is not active. Start a call first.',
    'zh-CN': '音频尚未启用，请先开始通话。',
  },
  'code.audio_epoch_unavailable': {
    en: 'The audio session is unavailable.',
    'zh-CN': '音频会话不可用。',
  },
  'code.audio_input_unavailable': {
    en: 'Microphone input is unavailable.',
    'zh-CN': '麦克风输入不可用。',
  },
  'code.audio_output_unavailable': {
    en: 'Voice output is unavailable.',
    'zh-CN': '语音输出不可用。',
  },
  'code.discovery_unreadable': {
    en: 'Could not read the Qwen Live Harness connection file.',
    'zh-CN': '无法读取 Qwen Live Harness 连接文件。',
  },
  'code.discovery_not_regular_file': {
    en: 'The Qwen Live Harness connection file is invalid.',
    'zh-CN': 'Qwen Live Harness 连接文件无效。',
  },
  'code.discovery_permissions': {
    en: 'The Qwen Live Harness connection file has unsafe permissions.',
    'zh-CN': 'Qwen Live Harness 连接文件权限不安全。',
  },
  'code.discovery_owner': {
    en: 'The Qwen Live Harness connection file has an unexpected owner.',
    'zh-CN': 'Qwen Live Harness 连接文件所有者不匹配。',
  },
  'code.discovery_size': {
    en: 'The Qwen Live Harness connection file exceeds the allowed size.',
    'zh-CN': 'Qwen Live Harness 连接文件过大。',
  },
  'code.discovery_json': {
    en: 'The Qwen Live Harness connection file is not valid JSON.',
    'zh-CN': 'Qwen Live Harness 连接文件不是有效的 JSON。',
  },
  'code.discovery_shape': {
    en: 'The Qwen Live Harness connection file has an invalid format.',
    'zh-CN': 'Qwen Live Harness 连接文件格式无效。',
  },
  'code.discovery_protocol': {
    en: 'The Qwen Live Harness connection protocol is incompatible.',
    'zh-CN': 'Qwen Live Harness 连接协议不兼容。',
  },
  'code.discovery_url': {
    en: 'The Qwen Live Harness connection address is invalid.',
    'zh-CN': 'Qwen Live Harness 连接地址无效。',
  },
  'host.error.captureTooLarge': {
    en: 'Visual capture exceeds the protocol limit.',
    'zh-CN': '画面超过协议允许的大小。',
  },
  'host.error.quitUnconfirmed': {
    en: 'Qwen Live Harness shutdown was not confirmed; retry Quit.',
    'zh-CN': '尚未确认 Qwen Live Harness 已关闭，请重试退出。',
  },
  'host.error.quitCredentials': {
    en: 'Missing shutdown credentials.',
    'zh-CN': '缺少当前 Qwen Live Harness 实例的退出凭证。',
  },
  'host.error.quitRejected': {
    en: 'Shutdown request was rejected.',
    'zh-CN': '退出请求被拒绝。',
  },
  'host.error.quitAck': {
    en: 'Invalid shutdown acknowledgement.',
    'zh-CN': '退出确认无效。',
  },
  'host.error.stopFailed': {
    en: 'Could not stop the current Qwen Live Harness call.',
    'zh-CN': '无法结束当前 Qwen Live Harness 通话。',
  },
  'host.error.stopTimeout': {
    en: 'Qwen Live Harness stop timed out.',
    'zh-CN': '结束 Qwen Live Harness 通话超时。',
  },
  'host.error.memoryInvalid': {
    en: 'Invalid memory settings.',
    'zh-CN': '无效的记忆设置。',
  },
  'host.error.memoryUnavailable': {
    en: 'Memory settings are unavailable while disconnected.',
    'zh-CN': '连接断开时无法修改记忆设置。',
  },
  'host.error.memoryBusy': {
    en: 'A memory change is already in progress.',
    'zh-CN': '正在修改记忆设置，请稍候。',
  },
  'host.error.endCallFirst': {
    en: 'End the current call before changing this setting.',
    'zh-CN': '请先结束当前通话，再修改此设置。',
  },
  'host.error.memoryTimeout': {
    en: 'Memory settings timed out. Please try again.',
    'zh-CN': '记忆设置超时，请重试。',
  },
  'host.error.memorySendFailed': {
    en: 'Could not send memory settings.',
    'zh-CN': '无法发送记忆设置。',
  },
  'host.error.memoryCallChanged': {
    en: 'The Qwen Live Harness call changed before the memory update completed.',
    'zh-CN': '记忆更新完成前，当前通话已改变，请重试。',
  },
  'host.error.memoryDisconnected': {
    en: 'The daemon disconnected before the memory update completed.',
    'zh-CN': '记忆更新完成前，Qwen Live Harness 连接已断开。',
  },
  'host.error.visualUnavailable': {
    en: 'Visual capture is unavailable.',
    'zh-CN': '画面采集暂不可用。',
  },
  'host.error.visualWrongSource': {
    en: 'Visual capture returned the wrong source.',
    'zh-CN': '采集结果的画面来源不匹配。',
  },
  'host.error.shortcutUnavailable': {
    en: 'Global shortcut registration is unavailable.',
    'zh-CN': '无法注册全局快捷键。',
  },
  'host.error.visualStale': {
    en: 'The visual request belongs to a stale Qwen Live Harness call.',
    'zh-CN': '画面请求属于已结束的通话。',
  },
  'host.error.visualStopped': {
    en: 'Visual capture stopped.',
    'zh-CN': '画面采集已停止。',
  },
  'host.error.untrusted': {
    en: 'Untrusted Qwen Live Harness Host renderer',
    'zh-CN': '无法验证 Qwen Live Harness Host 界面。',
  },
  'host.error.untrustedQuit': {
    en: 'Untrusted quit request.',
    'zh-CN': '无法验证退出请求。',
  },
  'host.error.untrustedMemory': {
    en: 'Untrusted memory settings request.',
    'zh-CN': '无法验证记忆设置请求。',
  },
  'host.error.requiredMessage': {
    en: 'Required Qwen Live Harness message "{messageType}" could not reach the daemon. Reconnecting.',
    'zh-CN':
      '必要的 Qwen Live Harness 消息“{messageType}”未能送达，正在重新连接。',
  },
  'host.error.notReady': {
    en: 'Qwen Live Harness Host is not ready.',
    'zh-CN': 'Qwen Live Harness Host 尚未就绪。',
  },
  'host.error.shortcutInvalid': {
    en: 'That shortcut is invalid.',
    'zh-CN': '此快捷键无效。',
  },
  'host.error.shortcutInUse': {
    en: 'That shortcut is already in use.',
    'zh-CN': '此快捷键已被占用。',
  },
  'host.device.fallback': {
    en: 'Microphone {index}',
    'zh-CN': '麦克风 {index}',
  },
  'host.settings.unavailable': {
    en: 'Settings are unavailable. Please reconnect.',
    'zh-CN': '设置暂不可用，请重新连接。',
  },
  'host.error.visualSettingsFailed': {
    en: 'Could not change capture mode. Please try again.',
    'zh-CN': '未能切换获取模式，请重试。',
  },
  'host.config.unavailable': {
    en: 'Opening config is unavailable. Connect to an updated standalone Qwen Live Harness daemon.',
    'zh-CN': '暂时无法打开配置，请连接更新后的独立 Qwen Live Harness daemon。',
  },
  'host.config.inaccessible': {
    en: 'Cannot access a regular config.json file. Check the file or run qwen-live-harness init to create it.',
    'zh-CN':
      '无法访问常规 config.json 文件。请检查文件，或运行 qwen-live-harness init 创建配置。',
  },
  'host.config.openFailed': {
    en: 'Could not open config.json. Set a default text editor for JSON files and try again.',
    'zh-CN': '无法打开 config.json。请为 JSON 文件设置默认文本编辑器后重试。',
  },
  'host.language.unavailable': {
    en: 'Language settings are unavailable for this connection.',
    'zh-CN': '当前连接不支持更改语言设置。',
  },
  'host.language.busy': {
    en: 'A language change is already in progress.',
    'zh-CN': '正在更改语言，请稍候。',
  },
  'host.language.timeout': {
    en: 'Language settings timed out. Please try again.',
    'zh-CN': '语言设置超时，请重试。',
  },
  'host.language.sendFailed': {
    en: 'Could not send language settings.',
    'zh-CN': '无法发送语言设置。',
  },
  'host.language.disconnected': {
    en: 'The daemon disconnected before the language update completed.',
    'zh-CN': '语言更新完成前，Qwen Live Harness 连接已断开。',
  },
  'host.language.changedCall': {
    en: 'The Qwen Live Harness call changed before the language update completed.',
    'zh-CN': '语言更新完成前，当前通话已改变，请重试。',
  },
  'host.language.invalid': {
    en: 'Invalid language setting.',
    'zh-CN': '无效的语言设置。',
  },
  'host.language.saveFailed': {
    en: 'Could not save the local language preference.',
    'zh-CN': '无法保存本地语言偏好。',
  },
  // SUBAGENTS_MESSAGES
  'subagents.back': { en: 'Back', 'zh-CN': '返回' },
  'subagents.title': { en: 'Subagents', 'zh-CN': '子智能体' },
  'subagents.terminalSessions': {
    en: 'Terminal sessions',
    'zh-CN': '终端会话',
  },
  'subagents.refreshSessions': { en: 'Refresh', 'zh-CN': '刷新' },
  'subagents.sessionsReadOnly': {
    en: 'Read only · Configure controller authorization for this Qwen backend to send text instructions.',
    'zh-CN': '只读 · 请为此 Qwen 后端配置 controller 授权，以发送文字指令。',
  },
  'subagents.sessionsInstructions': {
    en: 'Terminal sessions support text instructions only. Stopping, approvals and images are unavailable here.',
    'zh-CN': '终端会话仅支持文字指令，暂不支持停止、审批或图片。',
  },
  'subagents.sessionsCanInstruct': {
    en: 'Text instructions enabled · Name this terminal in your voice request.',
    'zh-CN': '可发送文字指令 · 说出此终端名称和要发送的内容。',
  },
  'subagents.instructionDeliveries': {
    en: 'Instruction deliveries',
    'zh-CN': '指令投递',
  },
  'subagents.deliveryNotCompletion': {
    en: 'Delivered means the terminal received the instruction. Task completion still needs a later result.',
    'zh-CN': '送达表示终端收到了指令；任务是否完成仍需后续结果确认。',
  },
  'subagents.noInstructionDeliveries': {
    en: 'No terminal instructions have been sent in this call.',
    'zh-CN': '本次通话尚未发送终端指令。',
  },
  'subagents.deliveriesOmitted': {
    en: '{count} older instruction deliveries are not shown.',
    'zh-CN': '另有 {count} 条较早的投递记录未显示。',
  },
  'subagents.deliveryPending': { en: 'Awaiting receipt', 'zh-CN': '等待回执' },
  'subagents.deliveryHeld': {
    en: 'Awaiting terminal review',
    'zh-CN': '等待终端审阅',
  },
  'subagents.deliveryDelivered': { en: 'Delivered', 'zh-CN': '已送达' },
  'subagents.deliveryDenied': {
    en: 'Denied by recipient',
    'zh-CN': '接收方已拒绝',
  },
  'subagents.deliveryRefused': {
    en: 'Terminal is not accepting instructions',
    'zh-CN': '终端不接受指令',
  },
  'subagents.deliveryExpired': {
    en: 'Delivery expired',
    'zh-CN': '投递已过期',
  },
  'subagents.deliveryMisaddressed': {
    en: 'Target session changed',
    'zh-CN': '目标会话已变化',
  },
  'subagents.deliveryDropped': {
    en: 'Not accepted by terminal',
    'zh-CN': '终端未接收',
  },
  'subagents.deliveryUnknown': {
    en: 'Delivery outcome unknown',
    'zh-CN': '投递结果不明',
  },
  'subagents.deliveryFailed': { en: 'Sending failed', 'zh-CN': '发送失败' },
  'subagents.deliveryTracking': {
    en: 'Watching for receipt updates',
    'zh-CN': '继续关注回执更新',
  },
  'subagents.deliveryTrackingEnded': {
    en: 'Receipt tracking ended',
    'zh-CN': '回执跟踪已结束',
  },
  'subagents.deliveryUnknownDetail': {
    en: 'The terminal may have received this instruction. Check before sending it again.',
    'zh-CN': '终端可能已收到此指令，请先核实再决定是否重发。',
  },
  'subagents.deliveryTime': {
    en: 'Started {created} · Updated {updated}',
    'zh-CN': '发起于 {created} · 更新于 {updated}',
  },
  'subagents.sessionReports': { en: 'Session reports', 'zh-CN': '会话汇报' },
  'subagents.reportsAttribution': {
    en: 'Reports describe what a session says. Linking a registered source does not verify identity or confirm task completion.',
    'zh-CN':
      '这里展示会话的自述信息。关联登记来源不代表身份认证，也不确认任务已完成。',
  },
  'subagents.noSessionReports': {
    en: 'No session reports received in this call.',
    'zh-CN': '本次通话尚未收到会话汇报。',
  },
  'subagents.reportsOmitted': {
    en: '{count} older reports are not shown.',
    'zh-CN': '另有 {count} 条较早的汇报未显示。',
  },
  'subagents.reportSourceMatched': {
    en: 'Linked to a registered source',
    'zh-CN': '已关联登记来源',
  },
  'subagents.reportSourceUnconfirmed': {
    en: 'Source unconfirmed',
    'zh-CN': '来源未确认',
  },
  'subagents.reportProgress': { en: 'Reported progress', 'zh-CN': '进展汇报' },
  'subagents.reportBlocked': { en: 'Reported blocker', 'zh-CN': '阻塞汇报' },
  'subagents.reportResult': { en: 'Reported result', 'zh-CN': '结果自述' },
  'subagents.reportInfo': { en: 'Information', 'zh-CN': '信息' },
  'subagents.reportQueued': { en: 'Waiting to announce', 'zh-CN': '等待播报' },
  'subagents.reportSubmitted': {
    en: 'Submitted for announcement',
    'zh-CN': '已提交播报',
  },
  'subagents.reportSpeaking': { en: 'Announcing', 'zh-CN': '正在播报' },
  'subagents.reportAnnounced': { en: 'Announced', 'zh-CN': '已播报' },
  'subagents.reportInterrupted': {
    en: 'Announcement interrupted',
    'zh-CN': '播报被打断',
  },
  'subagents.reportUnspoken': { en: 'Not announced', 'zh-CN': '未播报' },
  'subagents.reportSuppressed': {
    en: 'Announcement skipped',
    'zh-CN': '已跳过播报',
  },
  'subagents.reportTime': {
    en: 'Received {received} · Updated {updated}',
    'zh-CN': '收到于 {received} · 更新于 {updated}',
  },
  'subagents.executionUnknown': {
    en: 'Execution status unknown',
    'zh-CN': '执行状态未知',
  },
  'subagents.terminalOrigin': {
    en: 'Terminal · {backend} · {session}',
    'zh-CN': '终端 · {backend} · {session}',
  },
  'subagents.noTerminalSessions': {
    en: 'No terminal sessions were discovered.',
    'zh-CN': '未发现终端会话。',
  },
  'subagents.sessionsOmitted': {
    en: '{count} other terminal sessions are not shown.',
    'zh-CN': '另有 {count} 个终端会话未显示。',
  },
  'subagents.details': { en: 'Task details', 'zh-CN': '任务详情' },
  'subagents.stop': { en: 'Stop', 'zh-CN': '停止' },
  'subagents.stopTask': {
    en: 'Stop task: {title}',
    'zh-CN': '停止任务：{title}',
  },
  'subagents.stopping': { en: 'Stopping…', 'zh-CN': '正在停止…' },
  'subagents.stopUnsupported': {
    en: 'This backend does not support stopping an individual task.',
    'zh-CN': '此后端不支持单独停止任务。',
  },
  'subagents.stopUntracked': {
    en: 'The backend has not confirmed this task’s identity. Stopping it is unavailable.',
    'zh-CN': '后端尚未确认此任务的身份，暂时无法安全停止。',
  },
  'subagents.previous': { en: 'Previous', 'zh-CN': '上一页' },
  'subagents.next': { en: 'Next', 'zh-CN': '下一页' },
  'subagents.page': {
    en: '{start}–{end} of {total}',
    'zh-CN': '{start}–{end} / {total}',
  },
  'subagents.loading': { en: 'Loading…', 'zh-CN': '正在加载…' },
  'subagents.retry': { en: 'Retry', 'zh-CN': '重试' },
  'subagents.permissions': { en: 'Approval required', 'zh-CN': '需要授权' },
  'subagents.unassignedPermissions': {
    en: 'Other backend approvals · Task identity unconfirmed',
    'zh-CN': '其他后端授权 · 尚未确认所属任务',
  },
  'subagents.morePermissions': {
    en: '{count} more pending requests. Resolve these to see the next ones.',
    'zh-CN': '另有 {count} 项待处理请求，处理后可查看后续请求。',
  },
  'subagents.allow': { en: 'Allow', 'zh-CN': '允许' },
  'subagents.allowOnce': { en: 'Allow once', 'zh-CN': '仅允许本次' },
  'subagents.allowAlways': { en: 'Always allow', 'zh-CN': '始终允许' },
  'subagents.deny': { en: 'Deny', 'zh-CN': '拒绝' },
  'subagents.denyOnce': { en: 'Deny once', 'zh-CN': '仅拒绝本次' },
  'subagents.denyAlways': { en: 'Always deny', 'zh-CN': '始终拒绝' },
  'subagents.permissionScope': {
    en: 'These choices use the scope offered by the backend.',
    'zh-CN': '这些选项的授权范围由后端提供。',
  },
  'subagents.permissionNoChoice': {
    en: 'This request has no supported decision here. Use the backend’s approval interface.',
    'zh-CN': '此请求没有可在这里处理的选项，请使用后端的授权界面。',
  },
  'subagents.permissionTruncated': {
    en: 'This request is too long to display in full. Review and approve it in the backend; you can still deny it here.',
    'zh-CN': '此请求过长，无法完整显示。请在后端查看并授权；仍可在这里拒绝。',
  },
  'subagents.outcome.stopping': {
    en: 'Stop requested. Waiting for the backend to confirm.',
    'zh-CN': '已请求停止，正在等待后端确认。',
  },
  'subagents.outcome.stopped': { en: 'Task stopped.', 'zh-CN': '任务已停止。' },
  'subagents.outcome.already_ended': {
    en: 'This task has already ended.',
    'zh-CN': '此任务已结束。',
  },
  'subagents.outcome.allowed': {
    en: 'Approval sent to the backend.',
    'zh-CN': '授权已发送给后端。',
  },
  'subagents.outcome.denied': {
    en: 'Denial sent to the backend.',
    'zh-CN': '拒绝决定已发送给后端。',
  },
  'subagents.error.unsupported': {
    en: 'Update Qwen Live Harness to enable task controls.',
    'zh-CN': '请更新 Qwen Live Harness 以启用任务管理。',
  },
  'subagents.error.unavailable': {
    en: 'Task controls are unavailable. Reconnect and retry.',
    'zh-CN': '任务管理暂不可用，请重新连接后重试。',
  },
  'subagents.error.invalid_request': {
    en: 'Invalid task action. Refresh and retry.',
    'zh-CN': '任务操作无效，请刷新后重试。',
  },
  'subagents.error.not_found': {
    en: 'This task is no longer available.',
    'zh-CN': '此任务已不存在。',
  },
  'subagents.error.not_stoppable': {
    en: 'This task cannot be safely stopped from Qwen Live Harness.',
    'zh-CN': '无法从 Qwen Live Harness 安全停止此任务。',
  },
  'subagents.error.permission_unavailable': {
    en: 'This approval is no longer pending or the choice is unavailable.',
    'zh-CN': '此授权请求已处理，或该选项已不可用。',
  },
  'subagents.error.action_failed': {
    en: 'The backend did not confirm this action. Check the task and retry.',
    'zh-CN': '后端未确认此操作，请检查任务后重试。',
  },
  'subagents.error.stale_instance': {
    en: 'Qwen Live Harness restarted. Reopen Subagents before acting.',
    'zh-CN': 'Qwen Live Harness 已重启，请重新打开子智能体面板后操作。',
  },
  'subagents.openList': { en: 'View subagents', 'zh-CN': '查看子智能体' },
  'subagents.summaryLabel': {
    en: 'View subagents: {running} running, {completed} completed, {waiting} waiting for your input.',
    'zh-CN':
      '查看子智能体：{running} 项进行中，{completed} 项已完成，{waiting} 项等待你处理。',
  },
  'subagents.summaryWaiting': {
    en: '{count} waiting for your input',
    'zh-CN': '{count} 项等待你处理',
  },
  'subagents.openTask': {
    en: 'View task: {title}',
    'zh-CN': '查看任务：{title}',
  },
  'subagents.running': { en: 'Running', 'zh-CN': '进行中' },
  'subagents.completed': { en: 'Completed', 'zh-CN': '已完成' },
  'subagents.needsAttention': { en: 'Needs you', 'zh-CN': '需关注' },
  'subagents.queued': { en: 'Queued', 'zh-CN': '排队中' },
  'subagents.starting': { en: 'Starting', 'zh-CN': '启动中' },
  'subagents.monitoring': { en: 'Monitoring', 'zh-CN': '监测中' },
  'subagents.waiting': { en: 'Waiting for input', 'zh-CN': '等待输入' },
  'subagents.delivering': { en: 'Delivering', 'zh-CN': '播报中' },
  'subagents.failed': { en: 'Failed', 'zh-CN': '失败' },
  'subagents.cancelled': { en: 'Cancelled', 'zh-CN': '已取消' },
  'subagents.interrupted': { en: 'Interrupted', 'zh-CN': '已中断' },
  'subagents.empty': {
    en: 'No subagent tasks in this Qwen Live Harness run yet.',
    'zh-CN': '本次 Qwen Live Harness 运行尚无子智能体任务。',
  },
  'subagents.noRetained': {
    en: 'No task details are retained in this view.',
    'zh-CN': '当前视图未保留任务详情。',
  },
  'subagents.unavailable': {
    en: 'Subagents are unavailable for this connection.',
    'zh-CN': '当前连接不支持子智能体视图。',
  },
  'subagents.disconnected': {
    en: 'Disconnected · Showing last known activity.',
    'zh-CN': '连接已断开 · 显示最后收到的任务信息。',
  },
  'subagents.missing': {
    en: 'This task is no longer in the retained history for this Qwen Live Harness run.',
    'zh-CN': '当前 Qwen Live Harness 运行保留的历史中已没有这项任务。',
  },
  'subagents.omitted': {
    en: '{count} other tasks are not shown in this view.',
    'zh-CN': '另有 {count} 项任务未显示在当前视图中。',
  },
  'subagents.history': {
    en: 'Current Qwen Live Harness run · Closing this window does not stop tasks.',
    'zh-CN': '本次 Qwen Live Harness 运行 · 关闭此窗口不会停止任务。',
  },
  'subagents.otherCounts': {
    en: '{failed} failed · {cancelled} cancelled · {interrupted} interrupted',
    'zh-CN': '{failed} 失败 · {cancelled} 已取消 · {interrupted} 已中断',
  },
  'subagents.request': { en: 'Original request', 'zh-CN': '原始任务' },
  'subagents.activity': { en: 'Recent activity', 'zh-CN': '近期动态' },
  'subagents.output': { en: 'Public output', 'zh-CN': '公开输出' },
  'subagents.result': { en: 'Result', 'zh-CN': '结果' },
  'subagents.noActivity': {
    en: 'No activity received yet.',
    'zh-CN': '尚未收到任务动态。',
  },
  'subagents.noOutput': {
    en: 'No public output received yet.',
    'zh-CN': '尚未收到公开输出。',
  },
  'subagents.truncated': {
    en: 'Only retained output is shown; earlier text was trimmed.',
    'zh-CN': '仅显示保留的输出，较早的内容已裁剪。',
  },
  'subagents.updated': { en: 'Updated {time}', 'zh-CN': '更新于 {time}' },
  'subagents.backend': { en: 'Backend', 'zh-CN': '执行后端' },
  'subagents.source': { en: 'Source', 'zh-CN': '输入源' },
  'subagents.harness': { en: 'Agent task', 'zh-CN': '智能体任务' },
  'subagents.proactive': { en: 'Proactive task', 'zh-CN': '主动任务' },
  'subagents.triggers': {
    en: 'Triggers: {count}',
    'zh-CN': '触发次数：{count}',
  },
  'subagents.pendingNotifications': {
    en: 'Pending announcements: {count}',
    'zh-CN': '等待播报：{count}',
  },
  'subagents.notificationQueued': {
    en: 'Announcement queued',
    'zh-CN': '播报已入队',
  },
  'subagents.notificationSpeaking': {
    en: 'Announcing',
    'zh-CN': '正在播报',
  },
  'subagents.notificationDelivered': {
    en: 'Announcement delivered',
    'zh-CN': '已播报',
  },
  'subagents.remaining': {
    en: 'Remaining: {seconds}s',
    'zh-CN': '剩余：{seconds} 秒',
  },
  'subagents.eventStatus': { en: 'Status', 'zh-CN': '状态' },
  'subagents.eventMessage': { en: 'Message', 'zh-CN': '消息' },
  'subagents.eventPlan': { en: 'Plan', 'zh-CN': '计划' },
  'subagents.eventTool': { en: 'Tool', 'zh-CN': '工具' },
  'subagents.eventObservation': { en: 'Observation', 'zh-CN': '观察' },
  'subagents.eventNotification': { en: 'Announcement', 'zh-CN': '播报' },
  'subagents.openFailed': {
    en: 'Could not open this task. Please try again.',
    'zh-CN': '无法打开任务，请重试。',
  },
  'subagents.loadFailed': {
    en: 'Could not load subagent activity. Close and reopen this window.',
    'zh-CN': '无法加载子智能体动态，请关闭后重新打开窗口。',
  },
  'subagents.reconnecting': {
    en: 'Reconnecting to task updates',
    'zh-CN': '正在重新连接任务更新',
  },
  'subagents.outcomeUnknown': {
    en: 'Task ended without a confirmed outcome',
    'zh-CN': '任务已结束，但未确认结果',
  },
  'subagents.callEnded': {
    en: 'Voice call ended',
    'zh-CN': '语音通话已结束',
  },
  // SUBAGENTS_MESSAGES_END
  'tray.show': {
    en: 'Show Qwen Live Harness',
    'zh-CN': '显示 Qwen Live Harness',
  },
  'tray.start': { en: 'Start call', 'zh-CN': '开始对话' },
  'tray.new': { en: 'New conversation', 'zh-CN': '新对话' },
  'tray.stop': { en: 'End call', 'zh-CN': '结束对话' },
  'tray.quit': {
    en: 'Quit Qwen Live Harness Host',
    'zh-CN': '退出 Qwen Live Harness Host',
  },
  'tray.tooltip': {
    en: 'Qwen Live Harness Host · {state}',
    'zh-CN': 'Qwen Live Harness Host · {state}',
  },
} as const satisfies Record<string, Record<LiveLanguage, string>>;

export type LiveMessageKey = keyof typeof LIVE_MESSAGES;
export type LiveMessageParams = Readonly<Record<string, string | number>>;

/** Browser-safe mapping: never put raw process errors or credentials into UI text. */
export function startupErrorMessage(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  const key = typeof code === 'string' ? `startup.${code}` : '';
  return liveMessage(
    Object.hasOwn(LIVE_MESSAGES, key)
      ? (key as LiveMessageKey)
      : 'startup.daemon_start_failed',
  );
}

export function isLiveLanguage(value: unknown): value is LiveLanguage {
  return value === 'en' || value === 'zh-CN';
}

export function liveText(
  language: LiveLanguage,
  key: LiveMessageKey,
  params: LiveMessageParams = {},
): string {
  return LIVE_MESSAGES[key][language].replace(
    /\{(\w+)\}/g,
    (token, name: string) =>
      params[name] === undefined ? token : String(params[name]),
  );
}

const MESSAGE_PREFIX = 'qwen-live-harness-ui:';

/** Carry a stable message through status fields and Electron's error bridge. */
export function liveMessage(
  key: LiveMessageKey,
  params: LiveMessageParams = {},
): string {
  const bounded: Record<string, string | number> = { ...params };
  const encode = () =>
    `${MESSAGE_PREFIX}${JSON.stringify({ key, params: bounded })}`;
  let encoded = encode();
  // Status fields cap messages at 512+ characters. Clip detail, never JSON.
  while (encoded.length > 512) {
    const longest = Object.entries(bounded)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].length > 1,
      )
      .sort((left, right) => right[1].length - left[1].length)[0];
    if (!longest)
      return `${MESSAGE_PREFIX}${JSON.stringify({ key, params: {} })}`;
    bounded[longest[0]] =
      `${longest[1].slice(0, Math.floor((longest[1].length - 1) / 2))}…`;
    encoded = encode();
  }
  return encoded;
}

export function displayLiveMessage(
  language: LiveLanguage,
  value: string,
  depth = 0,
): string {
  const codeKey = `code.${value}`;
  if (Object.hasOwn(LIVE_MESSAGES, codeKey))
    return liveText(language, codeKey as LiveMessageKey);
  const start = value.indexOf(MESSAGE_PREFIX);
  if (start < 0) return value;
  if (
    start > 0 &&
    !/^(?:Error: |Error invoking remote method ['"]live:[^'"]+['"]: Error: )$/.test(
      value.slice(0, start),
    )
  )
    return value;
  try {
    const parsed: unknown = JSON.parse(
      value.slice(start + MESSAGE_PREFIX.length),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return value;
    const record = parsed as Record<string, unknown>;
    const key = record['key'];
    const params = record['params'];
    if (typeof key !== 'string' || !Object.hasOwn(LIVE_MESSAGES, key))
      return value;
    if (!params || typeof params !== 'object' || Array.isArray(params))
      return value;
    if (
      Object.values(params).some(
        (entry) => typeof entry !== 'string' && typeof entry !== 'number',
      )
    )
      return value;
    const renderedParams = Object.fromEntries(
      Object.entries(params).map(([name, entry]) => [
        name,
        typeof entry === 'string' && depth < 3
          ? displayLiveMessage(language, entry, depth + 1)
          : entry,
      ]),
    );
    return liveText(
      language,
      key as LiveMessageKey,
      renderedParams as LiveMessageParams,
    );
  } catch {
    return value;
  }
}
