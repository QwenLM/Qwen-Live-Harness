# Agent Remote

[English](README.md)

用 iPhone 把任务交给电脑上的 **Qwen Code / Codex CLI**，查看进度、结果并请求停止。电脑接入服务默认使用 **Qwen YOLO / Codex 完全访问**，残留的后台单次授权也自动处理。关掉手机 App 后，电脑继续执行。

本目录是独立项目：服务源码、iOS App、macOS 菜单栏应用、构建、依赖锁文件、测试和安装打包工具都在这里。运行时不依赖 Qwen Live Harness、Omni、Electron、语音密钥或相邻源码目录。

## macOS 小应用（推荐）

安装 `release/Agent-Remote-0.1.0-universal.pkg`，或打开同名 DMG，把 **Agent Remote** 拖入 Applications。打开应用、选择项目目录、启动服务即可。菜单栏面板会显示配对二维码、检测到的 Agent、连接状态与任务数量。在 iPhone 中添加电脑并扫码连接；已有手机配对和免审批设置继续沿用。

支持 macOS 13+、Apple Silicon 和 Intel。应用内置 Node.js 22.22.2、npm 和服务依赖，目标 Mac 不需要另外安装 Node、npm、Xcode 或原仓库。Qwen Code／Codex 仍需在目标电脑上自行安装和登录；应用会查找常见的 Homebrew、nvm 和用户安装路径。Codex 的 ACP 适配器首次使用时可能需要联网下载。

打开“登录后启动”后，当前用户登录时会启动菜单栏应用与服务；服务异常退出时由 launchd 重新启动。关闭窗口或退出菜单栏应用后，服务继续运行；需要结束时使用“停止服务”。关闭登录自启只影响下次登录，不打断当前任务。这是用户登录服务，尚未登录时不会启动；电脑休眠后仍会暂停连接。服务重启不恢复旧任务，更换项目目录需要等待任务结束，并会重启服务。

已有配对会继续使用 `~/.qwen-live-harness/mobile/`；新安装使用 `~/.agent-remote/`。“打开日志”会打开这个私有状态目录。更新时把应用安装到原来的 Applications 位置，等任务结束后在应用内重启服务，即可使用新版内置运行环境。卸载前先停止服务并关闭登录自启，再移除应用；配对文件会保留。

开发电脑需安装 Xcode 命令行工具及 Node.js 22.13+，执行：

```sh
npm ci
npm run test:macos
npm run build:macos
npm run check:macos
npm run package:macos -- --skip-build
```

构建时会校验固定版本的官方 Node 下载文件，生成通用二进制。`check:macos` 把完整应用移到临时目录，使用替身 Agent 和独立凭据，验证配对、免审批、项目切换、登录配置和真实 launchd 异常重启；不调用个人模型账号，也不改变实际服务。

本地构建使用临时签名（ad hoc），安装包没有 Apple 开发者签名，也未公证。另一台电脑可能拦截下载的副本。正式公开分发仍需 Developer ID Application／Installer 证书和 Apple 公证。可用 `AGENT_REMOTE_SIGN_IDENTITY`、`AGENT_REMOTE_INSTALLER_IDENTITY` 选择已安装的签名证书；公证是独立的分发步骤。

## 在另一台电脑安装

当前没有发布到 npm 公共仓库。使用本地生成的安装包，不要直接执行 `npm install -g agent-remote` 去获取未知同名包。

在开发电脑的本目录执行：

```sh
npm ci
npm run bundle
```

把生成的 `release/agent-remote-0.1.0.tgz` 复制到目标电脑。目标电脑需要 Node.js 22.13+，以及已经安装、登录并能在终端运行的 `qwen` 和／或 `codex`。然后执行：

```sh
npm install -g ./agent-remote-0.1.0.tgz
agent-remote --project "/absolute/path/to/project"
```

这会在前台启动服务，并打开本机配对页面。手机与电脑连接同一局域网，在 App 扫描二维码或粘贴链接，再点击连接。二维码由 Node.js 生成；电脑接入服务不需要 Xcode 或 Swift。默认端口为 47421，电脑应保持唤醒，防火墙应允许服务入站。

安装一个 Agent 就会出现一个选项，两个都安装会出现两个。Codex 首次执行时可能通过 npm 下载 ACP 适配器。任务使用目标电脑上的 Agent 账号与配置。

## Mac 后台服务

先停止已有的前台服务，再安装为当前用户的后台服务：

```sh
agent-remote service install --project "/absolute/path/to/project"
agent-remote pair
```

服务立即启动，并在该用户登录 Mac 后自动启动；关闭终端不会结束服务。它不是开机后无需登录的系统服务，也不会阻止电脑休眠。

```sh
agent-remote status
agent-remote service status
agent-remote service stop
agent-remote service start
agent-remote service uninstall
```

`stop` 会停止该服务和它创建的 Agent 工作；`uninstall` 还会移除本包的登录启动项，两者都保留配对凭据。重新执行 `service install` 可以更新项目配置，但活动任务或另一个前台服务存在时会拒绝替换。使用 nvm 等版本管理器更新 Node.js 安装路径后，需在没有活动任务时重新安装后台服务。

Linux 的前台运行要求 PATH 上有 OpenSSL，后台可交给自己的服务管理器。Windows 尚未完成适配和验收。当前真机与签名验收平台为 Mac + iPhone。

## 项目和权限

```sh
agent-remote --project "/path/project-a" --project "/path/project-b"
agent-remote --project "/path/project-a" --ask
agent-remote --project "/path/project-a" --port 47422
```

- 手机只能从电脑配置的项目列表中选择。工作目录不是文件系统沙箱，实际执行范围由 Agent 和操作系统决定。
- 每个任务创建独立 ACP 会话；不会接管电脑上已打开的聊天。Qwen 使用 `yolo` 模式，Codex 使用 `agent-full-access` 模式；后端缺少该模式时会记录提示，后台单次授权仍可自动处理。
- `--ask` 恢复逐次确认；默认免审批仅作用于本服务创建的会话，不改写 Agent 全局配置。
- 提交按请求 ID 去重；网络失败时不会自动重复创建任务。停止需要后台确认，点击停止本身不表示已经停止。
- 最多同时执行 4 个任务、保留 100 个任务；展示的进度和结果有长度限制。服务重启不恢复旧任务和会话。

## 配对和升级兼容

```sh
agent-remote pair
agent-remote pair --no-open
```

配对码十五分钟有效、仅能使用一次。`pair` 可以在服务运行中生成新码，不重启服务、不打断任务，也不撤销已有手机凭据。

新安装默认把状态存放在 `~/.agent-remote/`。如果发现旧版 `~/.qwen-live-harness/mobile/` 内已有证书或手机凭据，会继续原地使用这些文件。HTTPS API、配对链接格式、iOS Bundle ID 和钥匙串名称保持兼容；从旧版切换时不需要主动清空数据或重新配对。切换接入服务仍应先等旧任务结束，再停止旧进程，避免丢失运行中的会话。

```sh
agent-remote --data-dir "/custom/private/directory" --project "/path/project"
```

也可用 `AGENT_REMOTE_DATA_DIR` 指定独立状态目录。后续 `pair`、`status` 和服务命令需要使用同一目录。

手机固定校验证书指纹、地址和有效期，凭据存放在 iOS 钥匙串。地址变化或证书更新时可能需要重新配对。配对页包含一次性密钥，只保存在电脑私有目录，不通过网络 API 提供。

撤销现有手机权限：停止服务后，以 `--reset-pairing` 启动一次。此选项不能持久写入登录服务，否则每次登录都会撤销手机。

## iOS App

已经装好的 App 可以继续连接独立服务。构建新版需要 Xcode 和 XcodeGen：

```sh
npm ci
npm run build
cd ios
xcodegen generate
open QwenLiveMobile.xcodeproj
```

在 Xcode 为 `QwenLiveMobile` 选择自己的开发团队与 iPhone，然后 Run。为保留已有手机凭据，内部 Bundle ID、工程名和钥匙串标识沿用旧值；显示名称为 Agent Remote。团队、签名账号和设备 ID 不写入源码。

在 App 左上角打开“电脑”列表，点击“添加电脑”扫描另一台电脑的配对码。配对信息保存在手机钥匙串中；此后点选已保存的电脑即可切换，无需重复扫码。列表支持改名、重新配对和单独忘记一台电脑，重开 App 会恢复上次选择。

草稿、Agent／项目选择和待确认提交按电脑分别保留。切换不会停止其他电脑上的任务，也不会把旧请求重新发送给新电脑。旧版单台电脑的凭据和待确认提交会自动迁移；只有证书或授权失效时才需要重新配对。“忘记”只移除该电脑的手机记录，不停止电脑上的任务。

当前为局域网版，尚无公网中继、后台推送、语音或文件预览。

## 开发、验证和整体迁移

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run check:package
```

`check:package` 实际打包、在隔离目录全局安装，再用 HTTPS 和 ACP 测试子进程验证旧配对、二维码续期、Qwen/Codex、免审批和任务去重，不调用个人模型账号。

```sh
npm run test:ios-fixture
```

保持测试服务运行，再在 `ios` 重新生成项目并运行 Xcode 测试。每轮 UI 测试需新启动 fixture，因为配对码是一次性的。fixture 有效期一小时，真实服务为十五分钟；它只运行替身。生成的短期测试凭据已忽略，停止时清理。

要把整个项目移到独立仓库：

```sh
npm run export
```

复制 `release/agent-remote-source/`，或把 `release/agent-remote-source.tar.gz` 解压到目标位置即可。里面包含服务、iOS／macOS 源码、测试、锁文件、构建工具和从根 LICENSE 生成的分发副本，不包含 node_modules、下载的运行环境、用户凭据或构建缓存。移到任意目录后可直接 `npm ci && npm run build`。

在当前大仓库中，先执行一次 `npm ci --prefix packages/agent-remote`，旧的 `npm run mobile` 就会转向本包，默认仍使用调用命令时的项目目录。本包与 Host 一样独立安装依赖，未加入根 npm workspace。
