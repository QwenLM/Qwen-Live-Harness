# Qwen Live 独立拆分与仓库迁移

日期：2026-09-11。源代码基线：QwenLM/qwen-code `f649d65d1f49b049c7dac3365617d6d02f0a4cfe`（已合并 #11369）。目标仓库：QwenLM/Qwen-Live-Harness。

## 目标与现状

将已验证的 standalone Live daemon、macOS Host、原生 Appshot、测试和发布链迁入自己的仓库；新仓库能够独立安装依赖、构建、测试和打包，不需要 qwen-code checkout。随后在 qwen-code 的独立迁移分支下线内置语音实现及其专用入口，保留通用的会话、ACP、REST/SSE 和 peer 协议。

这是 #10118 的仓库及所有权收尾。Issue 中的勾选和部分版本描述已经落后于实现，不能据此判断所有里程碑都完成。

| 规划 / PR                                      | 当前证据                                                                     | 本次处理                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| M1/M2，#10367                                  | 独立 daemon、7 个工具、日志、结果注入、口头授权已合入                        | 搬迁源码与测试                    |
| M4，#10617                                     | ACP、多后端、能力降级及权限转发已合入                                        | 保留 Qwen / Qoder / 其他 ACP 接入 |
| M5，#10769                                     | 播放回执和 init 已合入，旧版内置 Live 尚未删除                               | 完成实际下线与发布归属迁移        |
| #11369                                         | 已合并；protocol v9、Screen/Camera、Live Feed、Proactive、Memory、Host UI    | 作为迁移基线全部保留              |
| M3，#10158 / #11090 / #11463 / #11488 / #11560 | Qwen peer 协议及 SDK 实现已合入；Live 尚未接入；npm SDK 0.1.12 尚不导出 peer | 用户已确认本轮只搬迁，M3 留待后续 |

关联 PR 均以 GitHub 的合并状态核实。M3 不能沿用旧 RFC 中“任意自称 controller 的 peer 都免审”的设想：只有用户显式铸造的 controller token、逐次显式标记的 controller 发送才拥有对应来源身份，接收方 hold/refuse 设置仍优先；peer 消息不代表批准待决权限。

## 仓库与运行时边界

新仓库保留两个目录：`packages/qwen-live` 为 Node daemon；`packages/live-host` 为 Electron macOS Host，包含原生 Appshot 源码和资源。Host 单独安装依赖，daemon 的普通安装不下载 Electron。纯文本 i18n 和协议契约在新仓库内部配套验证。

默认运行链路为 Host → 本机 WebSocket → qwen-live → ACP 子进程。Qwen Code 是可选后端；选择 REST/SSE adaptor 才连接 qwen serve。仅使用 Qoder 等 ACP 后端时，不安装或启动 Qwen Code。官方 SDK 只作为构建期依赖，其 HTTP client 编入可选 adaptor，并随包保留许可证；因为 SDK 的 npm 包还附带整个 Qwen CLI，不能把它列为运行时依赖。构建及 tarball 检查确认最终安装不含 SDK 包、Qwen CLI、core 或 acp-bridge；移除 file:../sdk-typescript 依赖和测试源码 alias。

qwen-code 侧删除 Live 专用 daemon/route、ACP 注入、语音转录回写、Web Shell 设置和 Host 安装发布入口。普通 Conversations runtime、会话活动状态、会话恢复日志、工具审批、steering、附件与 peer 通信属于后端通用能力，必须保留。不得把名字包含 live 的普通运行状态代码一概删除。

迁移审计发现原 ACP adaptor 还调用 `qwen/control/session/live-conversation` 并接收 `qwen/control/live/speak-to-user`，这是剩余的私有工具注入。本轮两端一并退役这些路径，不把旧私有接口作为兼容 fallback 留在新产品。用户已确认 M3 后续处理：本轮保留 ACP/REST 的轮末完成播报、实时权限提醒与 steering；不承诺通过 peer 发现/指挥现有终端会话，也不再通过私有注入工具做轮中主动汇报。Proactive 监控与提醒是 Live 自身功能，不因 M3 延后而移除。

## 用户数据与权限

保留 `qwen-live` 命令、`~/.qwen-live` 配置/记忆/日志及 `~/.qwen/live/daemon.json` discovery 路径、环境变量和旧配置读取。迁仓不执行配置重写、数据复制或删除，不把用户 API key、controller token、会话日志或屏幕数据写入仓库。

保留 Host bundle ID `com.alibaba.qwen-code.live-host`、签名 Team ID `NF4574S59H`、产品名与安装路径 `/Applications/Qwen Live Host.app`，以维持已有 macOS 授权身份。发布仍要求真实 Developer ID 签名、公证与验证；未签名本机构建不能冒充已验证的授权迁移。

Proactive 和 Memory 的既有模型调用与成本行为保持不变。迁移自动化测试使用本地 fake provider 和临时数据目录，不使用用户账户、摄像头、麦克风或已有后台会话。

## 构建、版本与发布

当前 npm daemon 已到 0.2.0，当前公开 Host manifest 也是 0.2.0 / protocol v7，源码中的 0.1.0 / 0.0.5 不是下次可发布版本。首次独立仓库候选版本统一为 0.3.0，配套 protocol v9。

新仓库拥有 npm lock、严格 TypeScript、daemon 与 Host 测试、协议一致性检查、npm 包内容检查，以及独立 CI 和手动发布 workflow。Host 的构建、资源、manifest 及发布脚本只依赖新仓库。集成测试通过外部可执行文件接入真实 Qwen CLI，默认协议测试使用自带 fake ACP，不通过 checkout qwen-code 来掩盖依赖。

目标仓库目前 private，尚无可见的发布 secrets/variables，旧公开下载源仍是 protocol v7。公开自动安装需要目标 release 可访问或配置可访问的分发源，以及签名、公证、npm 发布权限配置。代码迁移不会自动改变仓库可见性、复制证书/凭据、发布 npm 包或发布不匹配的 Host。新代码中发布归属指向新仓库，首次正式发行前以本地源码构建验证。

## 执行与交付

1. 固定源 SHA，记录来源、许可、迁移清单和 roadmap 差异。
2. 搬迁两个完整包、相关集成测试及发布工具，修复所有跨仓库构建/测试/资源路径。
3. 独立安装、构建、类型检查、Host 测试和协议 E2E；从 tarball 再验证安装入口。
4. 在 qwen-code 迁移分支删除旧实现，验证通用后端继续工作并检查包/构建/发布清单。
5. 按用户确认退役剩余私有主动汇报通道，保留通用 ACP/REST 回流；M3 不在本轮实现。
6. 对两个仓库完整 diff 进行自审和独立代码审查，修复后复验。
7. 将新仓库迁移成果提交并推送；qwen-code 的清理以可审查分支交付。创建任何新 PR 需要用户对那个 PR 的明确授权，不能以搬迁要求推定。首次正式发行所需的外部设置单独列出，不把源码迁移完成写成已公开发行。

迁移采用带固定来源 SHA 和保留版权头的源码快照，来源仓库完整历史仍可按 SHA 查阅。现有 checkout、用户测试环境和原始 Git 历史可用于回退；只删除迁移工作树中的版本控制文件。
