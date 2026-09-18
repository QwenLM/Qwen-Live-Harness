# 运行错误、日志与兜底讨论

本文用于区分“哪里失败了”“当前会影响什么”与“未来可以怎样恢复”。下面标为“建议”的行为尚未实施；已有的 Monitor 回收、Memory HTTP 重试、Host 界面恢复等会单独说明。主会话现有的有限恢复仅针对响应确认／取消状态失步，**不代表所有网络错误都会自动重连，更不会自动重试已执行的工具**。麦克风静音心跳另用于保活。

不是所有失败都会关闭应用。应区分单次操作、一个回答、一个子任务、某项功能、当前通话，以及整个 daemon 进程。通话结束后普通后台 Harness 任务可能仍在执行，不能因为小球停止播报就认定文件修改或命令也停止了。

## 1. 去哪里看日志

`<dataDir>` 默认是 `~/.qwen-live-harness`，可由 `QWEN_LIVE_HARNESS_DATA_DIR` 覆盖。

| 日志                  | 位置                                                  | 内容与保留方式                                                                                                                                                |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话事件 `SessionLog` | `<dataDir>/sessions/live-*.jsonl`                     | 会话、工具、回答、后台事件，以及已接入的 `failure` 记录；默认每 32 MiB 轮转为 `.1`、`.2` 等。一个事件文件不应被假定为只对应一个 `callId`                      |
| 常态运行错误          | `<dataDir>/logs/runtime-errors-<时间>-<随机ID>.jsonl` | 错误专用 JSONL，启动前后及退出阶段也可使用；当前文件达到 1 MiB 前轮转到同名 `.1`。每个实例使用独立文件，多次启动的整个目录并非总共只保留两份                  |
| Host 常态错误         | Electron `userData/logs/host-errors.log`              | 精选设备、权限、连接、renderer 等故障事件；当前文件和 `.1` 各最多 1 MiB，独立于 daemon 日志格式                                                               |
| Monitor 媒体归档      | 系统临时目录 `qwen-live-harness-monitor-debug/`       | 仅 debug 开启时记录逐轮 JPEG／WAV／JSON；跨模态共同保留最近 10 个 Monitor，见 [Monitor 诊断归档](../packages/qwen-live-harness/README_ZH.md#monitor-诊断归档) |

macOS 的 Host 日志默认位置通常是：

```text
~/Library/Application Support/qwen-live-harness-host/logs/host-errors.log
```

Host 的实际位置以 Electron `app.getPath('userData')` 为准。日志目录／文件使用私有权限检查；不能安全打开或写入时会跳过记录，而不是因此中断音视频。

**常态错误文件不要求 `--debug`。** 需要更详细的协议、Proactive 决策或媒体证据时，才另外使用：

```sh
qwen-live-harness --debug
```

源码运行时，在仓库根目录使用：

```sh
npm start -- --debug
```

不要只截取最后一行“failed”。优先保留同一 `callId`／`epoch` 周围的 `response.done`、`tool.call`、`tool.result`、`failure` 与必要的 Host 事件。分享前检查内容：会话事件和媒体归档可能包含私人对话、声音、画面与任务文字。

`--debug` 还会把 `realtime.protocol` 写入同一会话 JSONL，而不仅打印在终端。它记录入站响应、工具生命周期以及出站 `client.response.create`／`client.response.cancel`／工具回执的事件 ID、调用 ID 和等待状态。最终 `response.done` 的工具清单只保留有界的 ID、名称、状态和参数长度；不记录协议原包、Prompt、工具参数正文或音视频。可据此将实际发出的回执与服务端收到的 `event_id` 对齐，不能拿 `tool.result` 的本地执行完成时间代替 socket 发送证据。

### 麦克风静音与连接保活

麦克风处于静音状态时，主 Realtime 每隔 30 秒发送一次 1 秒长的零值 PCM16／16 kHz 单声道音频（32,000 字节），仅发送 `input_audio_buffer.append`，不主动 commit、创建回答或取消播报。它绕过真实麦克风输入分发，不提供给 Monitor 或 Memory，也不计作真实用户发言。解除静音、结束通话或连接终止时停止；仅关闭扬声器不会启用该心跳。

会话 JSONL 中的 `audio.input_mute_changed` 记录静音切换和初始化状态；`audio.input_heartbeat` 记录成功发送的心跳、provider Session ID 与出站 event ID，不记录音频内容。缓冲背压导致心跳跳过时记录 `input_heartbeat_backpressure`，不会仅因丢掉这段静音终止通话；真实发送异常仍按连接错误处理。

如果静音之前已有真实的未完成发言，心跳静音可能帮助服务端 VAD 结束那段发言；客户端不伪造 VAD 事件。服务端的内部错误或超时仍可能断开连接，心跳不能保证消除所有 `1011`。排查时对齐静音、心跳、最后一次响应与服务端关闭原因，不应直接将所有断连归因于静音。

## 2. 新增 `failure` 记录如何读

Daemon 的规范错误记录使用以下核心字段：

| 字段         | 含义                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `source`     | `realtime`、`host`、`tool`、`backend`、`proactive`、`memory` 或 `daemon`                                          |
| `code`       | 稳定的本地错误码，或可用的供应商错误码；没有可用值时使用受控的缺省值                                              |
| `stage`      | 发生阶段，例如 `connect`、`arguments`、`handler`、`function_call_output`、`audio_input`、`cleanup`                |
| `impact`     | `operation`、`response`、`task`、`feature`、`call` 或 `daemon`；表示记录该故障时的影响范围，不是恢复指令          |
| `message`    | 有长度限制并经过脱敏的说明                                                                                        |
| 可选关联标识 | `epoch`、`callId`、`providerSessionId`、`responseId`、`toolCallId`、`toolName`、`taskId`、`backend`               |
| 可选诊断字段 | `errorName`、`kind`、`providerType`、`param`、HTTP `status`、WebSocket `closeCode`、`fatal`、`executionUncertain` |

`kind` 的 `configuration`／`quota`／`transient`／`protocol` 是错误分类，部分依据供应商代码、状态和文本推断。**`transient` 不等于可以安全重试，`fatal:false` 也不等于这次操作成功。** `fatal` 需要结合来源理解：独立搜索或 Monitor 的连接失败不一定意味着主会话失败。

`executionUncertain:true` 尤其重要：超时、发送确认丢失或回执序列化失败，都不能证明工具没有执行。反过来，这个字段缺失也不是“已确认没有副作用”。

合成示例，展示运行错误文件的外层结构：

```json
{
  "ts": 0,
  "seq": 1,
  "pid": 12345,
  "type": "failure",
  "payload": {
    "source": "tool",
    "code": "tool_timeout_pending",
    "stage": "handler",
    "impact": "operation",
    "message": "The tool response timed out; execution may still continue and must not be retried automatically.",
    "callId": "call-demo",
    "responseId": "response-demo",
    "toolCallId": "tool-demo",
    "toolName": "handoff",
    "executionUncertain": true
  }
}
```

SessionLog 的外层仍是 `ts`、`seq`、`type`、`payload`，不要求存在 `pid`。Host 的 `host-errors.log` 则使用 `timestamp`、`source: "qwen-live-harness-host"`、`event` 和精选白名单字段，**不是上面的同一种 schema**。

新记录会过滤未允许的字段、已知凭据、常见认证内容及控制字符，记录结构不直接接收原始函数参数、headers、媒体或完整 stack。脱敏不等于匿名化：说明文本仍可能含文件路径或业务错误片段，分享前仍需检查。它不替代所有既有日志：`error`、`response.done`、`proactive.debug` 等仍然保留，也不能把历史会话日志一概当作已全面脱敏。

## 3. 主 Realtime 错误矩阵

表中的“代码／现象”包括规范 `failure` code、客户端现有错误码和供应商错误；不表示每一行都已经统一为一种本地 code。

| 来源／类别         | 代码或现象                                                                          | 当前影响与处理                                                                      | 未来兜底建议，尚未实施                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 配置与初始 prompt  | `invalid_endpoint`、`instructions_too_large`，认证／模型／参数的 400、401、403、404 | 连接无法建立，或配置类错误使当前通话失败；可将 provider 标记为配置不可用            | 指明需修正的字段；只对明确可修的参数进行有上限的纠正，不原样无限重连                                               |
| 建连与网络         | `connection_failed`、`connection_timeout`、`socket_error`、`http_<status>`          | 主连接失败；建连默认 8 秒超时                                                       | 无用户输入和工具提交的新握手，可讨论少量退避重试；进入交互后必须先核对执行状态                                     |
| 发送失败           | `send_failed`、`function_output_send_failed`                                        | 主连接结束；失败前的数据或工具可能已经被服务端接受                                  | 不重发可能有副作用的工具或权限票；先依据会话、call ID 和后台 job 记录核对                                          |
| 顶层供应商错误     | WebSocket `type: "error"`，包括 unknown `call_id`、无效参数、限流等                 | 当前客户端将其视为 fatal，结束主通话；不能假定只影响某一个工具                      | 将可证明属于单轮／单工具且仍能安全维持协议的错误隔离，需逐类验证；unknown call ID 不能靠换一个 ID 或重复执行“修复” |
| 单轮回答失败       | `response.done` 的 `status: "failed"`，`response_failed` 或供应商 code              | 没有待确认语音丢失时，报告非 fatal 错误，主连接可继续；已经执行的工具不一定取消     | 明确告知该轮失败；必要时重新组织回答，但不得重放该轮的 mutation                                                    |
| 输入转录失败       | `conversation.item.input_audio_transcription.failed`                                | 若仍有未解决输入，可能升级为 `unrecoverable_input`；否则只报告非 fatal ASR 错误     | 区分“回答已完成但转录缺失”和“整句话未被可靠接收”；后者引导用户重说，不编造缺失文本                                 |
| 未确认语音丢失     | `unrecoverable_input`                                                               | 结束通话；部分原始网络错误会被这个更保守的错误取代                                  | 保留底层原因与输入状态用于诊断；不要宣称可以透明恢复尚未可靠保存的音频                                             |
| 响应确认／取消超时 | `response_created_timeout`、`response_done_timeout`、`response_cancel_timeout`      | 主会话进入下文的有限 transport 恢复；direct 开始确认也有 15 秒期限，取消宽限期 2 秒 | 不将恢复扩大为已执行工具的重试；其他完成／网络失败需分别判断                                                       |
| 服务端关闭连接     | `connection_closed`，附 `closeCode`                                                 | 非本地主动关闭时结束当前通话；部分重启／异常 close code 归为 transient              | 新连接与旧调用状态隔离；不能把正常数值 close code 当成“先前动作没有发生”                                           |
| 本地回调抛错       | `callback_failed`                                                                   | 经 fail 路径终止主会话，副作用可能已经发生                                          | 先修复具体回调与错误边界，不把它当纯网络抖动进行重连循环                                                           |

普通传输错误被升级成 `unrecoverable_input` 时，代码会保留原始 cause，并另外记录 `stage: provider_cause`。下面的响应状态恢复不经过这条全局失败路径。

当前通话清理会取消本通话的原生搜索、请求停止自动转交查询、关闭 Monitor，并结束 Memory attachment。后台查询是否确实停止仍应以后端回执为准；**普通已委托的 Harness 工作也不因此获得回滚保证。**

### 响应确认与取消状态恢复

所有客户端创建的响应，包括普通用户的 `direct` 回答，都有默认 15 秒的 `response.created` 确认期限。用户打断尚未确认的响应时，最多等待 2 秒取消宽限期；没有响应 ID 时不发送 `response.cancel`，因为当前 API 会拒绝这种取消。已有响应 ID 才取消，并等待结束确认。

超期后，默认主会话的恢复包装层先隔离旧 transport，再建立新连接，每次逻辑通话最多尝试两次替换连接。迟到的旧响应、音频和工具调用不能被关联到新请求。恢复不结束 Host 通话，不重启后台 Harness、Monitor 或 Memory；未完成的主动通知保持 FIFO，恢复上下文先包含当前有效权限和任务状态，再处理新的用户输入。用户答复绑定原输入所对应的权限 ID；旧请求失效后，恢复的“允许”不能批准重连中新出现的请求，需要重新询问并获得新的用户答复。

只有尚未执行工具的最新用户输入可以恢复：优先使用完整 ASR；没有 ASR 时，仅使用具有可信起点、未被截断的真实麦克风缓存（上限 60 秒）。静音心跳不进入缓存。已经派发工具的旧请求不重播，旧工具回执也不发到新连接；后台任务继续通过自身状态事件报告结果。输入边界不可信时不猜半句话，界面提示用户重新说。恢复期间的新音频同样受大小限制。

`transport.recovery_started`／`transport.recovery_completed` 等元数据位于 `realtime.protocol` 中，并记录代次、原因和输入种类。若两次替换均失败、缓冲超限或上下文无法安全恢复，仍会明确结束这次交互并提示重试，而不是无限循环。一般网络断开、认证错误和 `Unknown function call id` 不会因此自动重试；非 direct 的完成等待仍有 120 秒上限，direct 的完成等待不是固定 120 秒总时长。

### 协议完整性与本地边界

下列客户端协议错误当前通常关闭主连接：

- 入站封装：`unexpected_binary_message`、`message_too_large`、`invalid_provider_message`。
- 输入／转录关联：`invalid_input_item`、`unattributed_final_transcript`、`ambiguous_final_transcript`、`ambiguous_input_transcript`、`too_many_pending_inputs`、`transcript_too_large`。
- 输出：`invalid_response`、`invalid_audio_frame`、`text_delta_too_large`。
- 函数调用流：`invalid_function_arguments`、`function_arguments_too_large`、`too_many_function_calls`、`ambiguous_handoff`。最后一个名字虽然含 handoff，实际也会检查其他已经 dispatch 后又变动参数的调用。

相关保护上限包括：入站消息 1 MiB、待跟踪输入 32 项、pending function call 8 项、函数参数 32 Ki 字符、函数结果 64 Ki 字符。这些协议上限不等于“只能创建 8 个后台子智能体”。

另有本地 `RangeError`／`false` 返回：instructions 超过 100,000 字符、非法 PCM／JPEG、上下文／播报／repair 参数越界等。它们本身不一定关闭 socket，影响由调用方决定。例如：

- 麦克风空帧返回 `false`；奇数字节或超过 64 KiB 的帧抛错，上层可能失败结束通话。
- 未开始输入音频、图像过期或图像发送被拒绝，可只丢弃该帧，不等同于主会话中断。
- 某些通知注入捕获异常后仅返回 `false`，可能表现为通知延后或未播报，而非显式断线。
- 重复／迟到的协议事件有些会被忽略；合理的旧事件丢弃与真正的协议损坏应分开分析。

对于关联歧义、函数参数被更改等错误，建议先保留现场并修复协议对齐，不为了“继续聊天”跳过身份校验。

## 4. 工具与后台执行矩阵

| 代码或现象                                         | 当前影响与处理                                                                                                        | 重试边界／未来建议                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tool_unknown`                                     | 返回未知工具错误回执，不调用 handler                                                                                  | 不自动猜测另一个工具或绕到 Harness；先修正工具声明与模型调用                                             |
| `tool_arguments_invalid`、`tool_arguments_shape`   | 记录诊断，但保留旧行为：把无效 JSON 或非对象参数降级为 `{}`，仍可能执行 handler；空字符串／纯空白本来就作为空参数处理 | **出现参数错误日志不证明没有执行。** 将来若改成执行前拒绝／有限纠参，属于另一项行为变更                  |
| `tool_handler_failed`                              | handler 异常转成原有错误回执；不能保证先前副作用回滚                                                                  | 核对任务、文件或服务实际状态，再决定是否重试                                                             |
| `tool_result_serialization_failed`                 | handler 已返回，但结果不能序列化，转错误回执                                                                          | 标记执行不确定；不能重新调用同一个 mutation 来换取可用回执                                               |
| `tool_timeout_pending`                             | 默认 30 秒返回 `status: "pending"`；handler 继续运行，不自动取消                                                      | 等待真实后台状态，禁止立即重试 handoff／授权／文件或命令操作                                             |
| `tool_business_rejected`                           | handler 正常返回 `status: "error"`；新增诊断，但历史 `ToolDispatchResult.ok` 仍可能是 `true`                          | 同时看业务 status 与诊断，不把调度层 ok 当业务成功；只对明确无副作用的错误考虑纠正                       |
| `tool_output_too_large`                            | 超大回执被替换为有界错误回执，操作可能已经完成                                                                        | 保留后台结果入口，不重复执行来缩短输出                                                                   |
| `tool_output_rejected`／未知、失配或过期的 call ID | 当前有效响应无法提交结果时可能结束通话；已明确属于失败 response 的迟到结果有专门忽略分支                              | 先区分合理迟到、已取消响应、服务端关联丢失。不得自造新 call ID 再提交旧结果，也不得重放权限票            |
| 后台任务自身失败／授权拒绝／backend 不可用         | 主要影响目标任务或操作；错误仍可能沿用 `backend.event`、`error`、业务回执等既有记录                                   | 默认 backend 预检失败可阻止启动；次要 backend 失败不必令主对话失败。权限拒绝不能作为换后端绕过限制的理由 |

业务 `note`、异常文本和完整结果仍以原回执语义处理；新的统一诊断只输出受控摘要和允许的字段。日志观察者抛错被隔离，不应改变 handler 调用次数、`ok`、回执或超时后的执行状态。

## 5. Host、设备与进程矩阵

| 来源／代码或 Host event                                                                                               | 当前影响与处理                                                                                | 未来兜底建议，尚未实施                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 麦克风无设备、权限／采集超时、`audio_input_rejected`、`audio_input_failed`                                            | 可能阻止通话开始或结束当前通话；主输入背压不会被当作无声丢帧忽略                              | 提示选择可用输入设备／修复权限；若未来提供可见文本入口，再讨论切换输入方式，不能假定当前已有文本兜底 |
| 输出设备／播放故障、`audio_output_unavailable`、`audio_output_backpressure`、`audio_output_send_failed`、结束标记失败 | 可能丢失或中断该次播报；某些进一步异常也会导致通话失败                                        | 保留可见结果和“未播报”状态，再有限重建播放设备；不要在未确认播放进度时整段重复播放                   |
| 相机／屏幕权限、截图超时或无效帧                                                                                      | 单次截图／视觉功能失败，某些 readiness 丢失也会结束当前通话                                   | 可以讨论降级为音频继续，但须明确“当前看不到画面”，不能以旧帧冒充新画面                               |
| Host 身份、版本、lease 或协议错误                                                                                     | `host_identity_rejected`、`host_lease_active` 等可拒绝连接；心跳／socket 断开可能影响当前通话 | 身份不符不自动接管或杀死别的实例；只恢复本应用拥有且身份可核验的连接                                 |
| `renderer_process_gone`、`renderer_unresponsive`、`preload_failed`、加载失败                                          | 已有 overlay 恢复控制器会使音频进入故障处理，并安排重载／重建界面；不是保证通话无缝恢复       | 建议为连续失败设置可见的重试边界；恢复界面与恢复原通话、重放任务应是不同决策                         |
| native addon／Host 主进程崩溃、进程被强制结束                                                                         | JS 可能来不及执行 logger；另一进程有时只能观察到连接关闭或心跳超时                            | 结合系统崩溃报告，不把缺日志当无故障；不能承诺自动保留全部崩溃现场                                   |

设备或网络恢复之后，是否重新开麦、开始通话、恢复视频发送，都涉及用户可见状态与隐私边界。它们不应被隐藏在“错误日志已记录”之后自动发生。

## 6. Web Search、Proactive 与 Memory 的隔离

| 子系统                   | 当前行为                                                                                                                                            | 不应作出的推断／未来讨论                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 独立 Web Search          | `web_search_failed`、`web_search_timeout` 结束该搜索连接；总预算 25 秒，握手不超过 8 秒。有后台时按现有逻辑新建隔离查询任务，没有后台则排队告知失败 | 通常不结束主通话。供应商细节仍可能被归并为受控错误，不能单靠该 code 判定是认证、网络还是参数。fallback 已接收后不能再次 handoff 复制任务 |
| 搜索取消／入参／权限     | `web_search_aborted`、Stop／End call 不触发 fallback；无效 query 返回错误；`web_search_unavailable` 可表示当前消息无权调用，不再表示模型白名单      | 不从内部通知、网页内容或被取消的任务自动重新发起搜索                                                                                     |
| 独立 Monitor             | `monitor_*` 连接、提交、响应、解析错误影响该 Monitor。初始化失败可直接令任务失败；运行中按已有逻辑回收连接，连续失败默认达到 3 次后停止任务         | 不把 Monitor socket 的 fatal 直接等同于主 socket 的 fatal。连接回收重放窗口内媒体也不是精确一次的现实事件检测保证                        |
| Proactive 通知           | 等待播放确认默认上限 30 秒；超时可使对应任务失败。冷却、等待 false 重新武装、等待媒体、前台忙碌是正常 gate，不全是错误                              | 区分“模型触发”“通知被接受”“实际播放”。重试通知必须考虑已播出的片段，不能默认重播                                                         |
| Memory 工具／存储        | `memory_tool_failed` 或 `memory.*` 错误通常返回失败回执、影响一个子操作或挂载功能；主对话通常仍可继续                                               | 没有 Memory 工具可能是未启用／未成功挂载，不是没有历史数据。不要自动清空库来恢复                                                         |
| Memory Embedding         | 查询默认 400 ms；HTTP、超时或无可用向量时可退到词法检索                                                                                             | 0 命中和词法降级不等于 API 崩溃。无结果不能证明整个记忆库为空                                                                            |
| Memory Observer／Updater | Observer 失败可等后续采样；Updater 可能为 `failed`、`empty` 或 `skipped`。HTTP 客户端已有至多一次网络／429／5xx 重试，共用原超时预算                | 整理未完成不应阻断普通回答；WM 更新成功不代表 LTM 已整理成功。重做 `omnibio.update/delete` 前必须重新核对当前索引                        |
| Monitor 归档写入         | 初始化、磁盘、权限、预算或淘汰失败只影响诊断归档，记录可能不完整                                                                                    | 不应为了“有录像”改变通话行为；未记录的旧音频不能追补                                                                                     |

这些隔离都有边界：独立子系统完成后仍需要主 Realtime 播报，而主连接在播报时遇到 fatal provider 错误，仍可结束当前通话。不能把“搜索计算独立”理解成“结果播报永远不会受主连接故障影响”。

## 7. 启动、退出和日志自身失败

| 代码或现象                                                                    | 当前含义与影响                                                                                                                               | 处理边界                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `configuration_load_failed`                                                   | 配置缺失、格式或字段校验等问题导致 CLI 无法正常启动                                                                                          | 修正明确字段；保留原文件和用户模型别名，不擅自重新 init 覆盖           |
| `runtime_missing`／`runtime_invalid`／`runtime_unavailable`、`config_missing` | 桌面启动登记、Node／CLI 路径或初始化条件不可用                                                                                               | 引导修复安装／登记，不下载或执行来源不明的替代运行时                   |
| `discovery_invalid`、`daemon_mismatch`、`daemon_unresponsive`、`startup_busy` | 已有实例或 discovery 无法被安全使用                                                                                                          | 核对进程身份与所属目录；不把无法确认的实例当成本应用可以强杀的子进程   |
| `daemon_start_failed`、`application_start_failed`、`startup_timeout`          | 启动中的具体阶段失败；daemon 日志会带 `stage`，如 `backend_preflight`、`memory_initialization`、`host_initialization`、`listen`、`discovery` | 优先修复对应阶段，不把所有情况统称“模型连不上”                         |
| `startup_aborted`、正常 SIGINT／SIGTERM                                       | 用户或上层要求停止可能是预期流程                                                                                                             | 不当作自动重新启动的理由                                               |
| `cleanup_failed`、`process_shutdown_failed`、`startup_cleanup_failed`         | 退出清理没有全部完成，资源或后台工作状态可能不确定                                                                                           | 确认具体自有资源后再重试清理，不能只隐藏小球就宣布后台全部停止         |
| `unhandled_rejection`                                                         | 已有后台 promise 拒绝处理器记录诊断；当前不因此自动退出进程                                                                                  | `impact: operation` 不代表整个应用仍健康，也不是成功恢复；需查具体状态 |
| 日志目录不可写、磁盘满、unsafe path 或写入失败                                | RuntimeFailureLog 返回失败，daemon 可发一次警告；SessionLog／Host 日志采用 best-effort 隔离，部分记录会缺失                                  | 不递归记录“日志写失败”造成错误风暴，也不让 logger 本身中断通话         |

同步写入错误文件能减少退出时丢日志，但没有把每条记录都变成强制持久化事务。**SIGKILL、断电、系统冻结、OOM、原生崩溃或存储故障下，日志完整性均无法保证。** 缺少最后一条错误日志不能证明是正常退出。

## 8. 建议分阶段讨论兜底，不直接开启全局重试

### 阶段一：先隔离回答／工具失败，再讨论有限纠参

- 优先让明确的只读查询或单轮内容失败不升级为整个通话失败；保留用户可见失败状态。
- 只有能够证明尚未执行、有明确参数纠正方向且仍受原权限约束时，才考虑一次有限纠参。
- 保持 call ID、任务 ID、后台 job 和权限请求的身份约束；拒绝、未知 ID、已取消请求不是另开任务的授权。
- 保留当前超时“执行可能继续”的语义；不要自动重复文件写入、命令、后台 mutation、权限允许／拒绝票或 `omnibio` 索引操作。

### 阶段二：可见的媒体降级

- 视觉失败时说明看不到新画面，再讨论仅音频继续；输出失败时保留可见结果与未播报状态。
- 麦克风或输入链路损坏时，不应继续把缺帧音频当完整发言。恢复设备、重新开始或未来的文本入口需要明确交互设计。
- 重建音频／摄像头设备应有次数和时间上限，不悄悄切换输入源或扩大权限。

### 阶段三：谨慎的连接恢复

- 先讨论少量、可取消、带退避的重连，保留原模型、地域与身份校验；不要把 `kind: transient` 直接接到无限循环。
- 默认只重建连接和已知幂等初始化，不透明重放用户音频、工具调用或权限决定。
- 已执行工作通过真实后台状态重新关联；队列通知依据是否已提交、已生成、已播放确认来决定是否重放，不能仅按“socket 断了”判定。
- 用户 Stop／Quit、新一代 call 或任务取消必须立即终止恢复尝试；测试覆盖重连期间的迟到结果和重复确认。

以上均为待评审方案。当前新增日志没有自动纠参、媒体降级或主会话透明重连，也没有承诺任务的 exactly-once 执行。

## 9. 覆盖边界与源码入口

本轮不是把所有 `catch` 都换成统一 logger。仍有旧式 `error`、`response.done`、子系统 debug event、布尔拒绝、正常取消和有意忽略的迟到事件；某些本地校验也没有独立稳定 code。规范记录可能在不同层出现多个影响范围，应该按关联标识阅读，不把日志条数当故障次数。

主要入口：

- [规范错误记录与常态文件](../packages/qwen-live-harness/src/log/runtime-failure.ts)
- [会话日志](../packages/qwen-live-harness/src/log/session-log.ts)
- [主 Realtime 协议与错误边界](../packages/qwen-live-harness/src/realtime/realtime-session.ts)
- [LiveSession 的工具、媒体与通话处理](../packages/qwen-live-harness/src/orchestrator/live-session.ts)
- [ToolDispatcher 的观察性日志](../packages/qwen-live-harness/src/tools/dispatcher.ts)
- [Host 协议协调](../packages/qwen-live-harness/src/host/qwen-live-harness-host-coordinator.ts)
- [Host 精选故障日志](../packages/qwen-live-harness-host/src/main/host-diagnostics.ts)
- [启动入口](../packages/qwen-live-harness/src/index.ts) 与 [daemon 资源清理](../packages/qwen-live-harness/src/daemon.ts)

提交问题时请提供版本、操作步骤、真实影响范围，以及同一关联 ID 下经过检查的日志片段。无需也不应默认上传完整会话、Memory 数据库或原始声音。
