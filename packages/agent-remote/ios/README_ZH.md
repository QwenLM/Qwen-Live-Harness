# Agent Remote iOS

[English](README.md) · [电脑接入服务安装说明](../README_ZH.md)

先在包目录执行 `npm ci && npm run build`，再执行：

```sh
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

选择自己的开发团队和已信任的 iPhone，点击 Run。显示名称为 Agent Remote。为了升级时保留已有配对，Bundle ID、配对链接协议和钥匙串标识沿用旧值；覆盖安装旧 App 时不要重命名这些标识。

模拟器测试示例：

```sh
xcodebuild -project QwenLiveMobile.xcodeproj -scheme QwenLiveMobile \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

完整 TLS/UI 测试需要先在包目录运行 `npm run test:ios-fixture` 并保持运行，再重新生成 Xcode 项目。每轮重跑都需重启 fixture；没有 fixture 时相关测试会明确跳过。自动化使用替身，真机网络、扫码、签名与真实 Agent 执行需分别验收。

客户端强制 HTTPS、拒绝重定向，并校验已配对证书的指纹、地址、有效期和服务器用途。ATS IPv4 例外用于允许私有证书，不绕过上述校验；测试覆盖错误指纹和明文请求拒绝。
