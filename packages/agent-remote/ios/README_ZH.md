# Agent Remote iOS

[English](README.md) · [电脑接入服务安装说明](../README_ZH.md)

先在包目录执行 `npm ci && npm run build`，再执行：

```sh
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

选择自己的开发团队和已信任的 iPhone，点击 Run。显示名称为 Agent Remote。为了升级时保留已有配对，Bundle ID、配对链接协议和钥匙串标识沿用旧值；覆盖安装旧 App 时不要重命名这些标识。

原生 SwiftUI 的四个标签依次为 **助手 → 工作台 → 动态 → 我的**。助手显示已连接工作台和本机保存输入中最近的三件事，底部固定文字、语音和 Live 入口。文字先保存在本机，不会自动派发任务。点击语音时才申请麦克风与语音识别权限，要求设备支持对应语言的本机识别；离开页面或 App 不活跃时停止录音。识别结果可在保存前检查和修改，不保存录音文件。

动态不设分类筛选，展示实际任务结果、产物引用与本机保存的输入。产物预览沿用现有的 HTTPS 证书固定与离线渲染校验。“我的”提供外观、语音语言、本机输入管理、任务结果收藏、电脑管理与隐私说明。没有数据时显示空状态，不填充示例成果。Omni 对话、Live 通话、长期记忆、每日总结和主动通知尚未接入；点击 Live 会说明当前状态，不会启动模拟通话。

工作台保留现有项目列表和表单。补充要求沿用同一个 Agent 会话，每轮分别展示结果、授权和停止状态。助手与动态的任务链接仅在电脑、上下文、服务运行及任务身份匹配时，打开现有会话。草稿继续按电脑、服务运行和会话隔离。多轮会话需要同时更新电脑接入服务；电脑服务重启后不会恢复旧会话。

任务结束后，运行耗时会固定下来。点击每轮回复下方的“产物”，可预览图片、Markdown 和静态 HTML。预览需要同时更新接入服务和 App；支持的文件与限制见[接入服务说明](../README_ZH.md#ios-app)。

模拟器测试示例：

```sh
xcodebuild -project QwenLiveMobile.xcodeproj -scheme QwenLiveMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

完整 TLS/UI 测试需要先在包目录运行 `npm run test:ios-fixture` 并保持运行，再重新生成 Xcode 项目。每轮重跑都需重启 fixture；没有 fixture 时相关测试会明确跳过。自动化使用替身，真机网络、扫码、签名与真实 Agent 执行需分别验收。

客户端强制 HTTPS、拒绝重定向，并校验已配对证书的指纹、地址、有效期和服务器用途。ATS IPv4 例外用于允许私有证书，不绕过上述校验；测试覆盖错误指纹和明文请求拒绝。
