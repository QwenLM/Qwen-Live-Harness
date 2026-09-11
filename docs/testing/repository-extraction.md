# 独立仓库迁移验收

基线：qwen-code `f649d65d1f49b049c7dac3365617d6d02f0a4cfe`。所有结果必须记录实际执行的命令、环境与通过/失败，不将 fake provider 的证据写成真实音视频验收。

## 基线检查

- 全局 `qwen --version`、`qwen --help`：确认外部后端入口，不修改登录态或调用模型。
- 新仓库最初为空，无法构建/测试。源 daemon 的 SDK 依赖为 file:../sdk-typescript，vitest alias 直读 SDK 源码；Host parity 测试还读取 CLI 的 Live types，图标路径也指向 Electron sibling。这些是独立安装必须消除的失败点。
- 当前公开 Host manifest 为 protocol v7，源码为 v9；不能用旧公开 Host 的“已安装”状态证明此次配套发行可用。

## 新仓库

1. 独立依赖：在新仓库 npm ci。检查运行时安装树无 Qwen CLI / core / SDK 包，无仓库外 file 依赖与符号链接。SDK 仅在开发期从 npm 安装，HTTP adaptor 单独打包，不把其附带的 CLI 带入发布包。
2. 构建与类型：npm run build、npm run typecheck；分别执行 daemon 单元测试及 Host build/typecheck/test。
3. 协议契约：Host 与 standalone daemon 的双向消息、音频帧、v9 epoch/outputId/结束回执一致；不再加载 qwen-code 类型或旧协议副本。
4. 打包：npm pack daemon，在 mktemp 创建的目录安装 tarball，运行 qwen-live --help 并导入公开入口；确认无测试、工作区源码、私有数据或 file: SDK 依赖。
5. 完整进程测试：fake DashScope + fake Host + ACP 子进程，验证直答、handoff、结果回流、语音授权、追加指令、打断、清理及 discovery 所有权。所有服务仅监听 loopback，配置/数据隔离。
6. 外部后端兼容：通过显式 TEST_CLI_PATH 使用实际 Qwen CLI，保留已有 M1/M2/M4 集成用例；不要求新仓库内存在 CLI/core 源码。Qoder 真账户测试另列，不擅自调用用户账户。
7. 原生打包：构建本机测试 app，校验 appId、协议、资源和原生模块；签名、公证及实际系统授权列为发行验证，不用开发启动替代。

## qwen-code 清理分支

- 构建、类型检查、相关单元测试、CLI bundle。
- 检查普通 qwen serve REST/SSE、ACP 初始化/会话/权限/steering 和 Conversations 工作区恢复仍可用。
- Live 专用路由、工具注入、语音转录、设置入口、安装/发布脚本和 workspace 包清单均删除；通用 live state/journal/agent panel 保留。
- 对照迁移清单审计残留；所有已删除源码可以由基线 SHA 恢复。

## 结果

2026-09-11，macOS arm64，Node 22.23.1 / npm 10.9.8：

| 验证                | 实际命令                                                                                                                                      | 结果                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 新仓库干净安装      | `npm ci`                                                                                                                                      | 通过，使用自身 npm lock 和 public registry，不链接 qwen-code node_modules                                                 |
| daemon 构建与类型   | `npm run build && npm run typecheck`                                                                                                          | 通过，含独立 integration-tests 类型检查                                                                                   |
| daemon 单元测试     | `npm run test:daemon`                                                                                                                         | 1,016 通过，2 个 Qoder 真账户用例跳过                                                                                     |
| 发布工具            | `npm run test:scripts`                                                                                                                        | 27 通过                                                                                                                   |
| 独立完整进程        | `npm run test:integration`                                                                                                                    | 3 通过；实际 daemon + ACP 子进程 + 本地 fake provider                                                                     |
| Host 类型与测试     | `npm run typecheck:host && npm run test:host`                                                                                                 | 通过；373 项测试                                                                                                          |
| Host 构建与本机打包 | `npm run build:host`，在 Host 内执行 `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.yml --mac dir --arm64` | 通过；原生模块含 arm64 / x86_64，测试 app 未签名、未安装或启动                                                            |
| 外部已发布后端      | `TEST_CLI_PATH=<SDK 0.1.12 所带 Qwen CLI 0.23.3> npm run test:backends`                                                                       | 8 suites / 17 tests 全通过；REST/SSE、ACP、权限、steering、多后端                                                         |
| 生产安装包          | `npm run check:package`                                                                                                                       | pack 后在独立临时目录仅安装生产依赖；CLI/help/import 和 3 个完整进程用例通过；没有 Qwen CLI、SDK、core、acp-bridge 安装包 |
| 仓库边界            | `npm run check:boundaries`                                                                                                                    | 通过；两包候选版本 0.3.0，配套协议 v9                                                                                     |
| 格式与 lint         | `npm run format:check && npm run lint`                                                                                                        | 通过                                                                                                                      |
| 生产依赖审计        | `npm audit --omit=dev --json`                                                                                                                 | 0 已知漏洞；完整开发树另有 Vitest 3 的 2 个 moderate，未强制跨大版本升级                                                  |

M1 用例已适配测试专用的 Memory/Proactive 关闭配置，并实际协商 v9 output end-marker。一次 direct response 同时输出音频与 handoff：扣住播放完成回执时，已完成的后台结果不得注入；释放匹配 epoch/outputId 的回执后，无新增用户语音即出现 COMPLETE、SPEAK_TO_USER 和 response.create。该用例不依赖下一轮用户说话来清掉播放状态。

独立授权用例使用真实 ACP SDK/子进程，必须先看到权限请求、确认任务尚未完成，再提交明确的 allow 选项，最后看到获准后的完成结果。迁移时修正了继承 fixture 缺失的 toolCallId，避免测试停在协议解码层却误报权限代码缺陷。

初始继承的手工 Qoder 用例曾因检测到本机 CLI 而调用了一次真实模型 PONG 探测。现已增加 `RUN_QODERCLI_SMOKE=1` 的显式开关；上表最终回归默认跳过这 2 项，不将初次运行计入 fake-only 验证。

源端清理的构建、类型与相关单测另在其分支验证。M3 peer 接入、真实连续语音/屏幕/摄像头验收、签名/公证、公开安装和首次正式发行尚未完成，不包含在上述通过结论内。Windows npm 启动兼容性修正经过代码检查，但没有原生 Windows 执行结果。
