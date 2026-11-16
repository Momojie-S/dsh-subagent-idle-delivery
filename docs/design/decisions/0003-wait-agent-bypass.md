# ADR-0003: wait_agent 活跃时旁路扣留并回注已暂存批

## 状态

accepted（2026-11-15）

## 背景

官方 `@deepseek-ai/dsh-tool-subagent-control` 提供 `wait_agent` 工具：模型在工具执行期间主动等待收件箱新输入，新消息到达即返回 `{"timedOut": false}`，当前步工具执行结束后消息在 step 边界被认领、并入下一次模型请求——**同轮内**模型见到正文。本插件先于此工具存在（设计时无 wait_agent）：忙碌即扣留的取舍与它正面冲突——wait_agent 执行期间父会话必为 running，其正在等的消息（`agent-message` / `subagent-settled`，恰为 `heldKinds` 默认项）被扣走，工具返回了"有输入"的回执、正文却要等整轮结束才投递。工具的核心承诺被插件废掉，且回执与正文分家会误导模型。

## 备选

1. **不修**：wait_agent 在本插件挂载的部署上持续失效。
2. **活跃旁路 + 开账回注**（本决策）：按会话记"正在执行的 wait_agent 调用"账（`src/waits.ts` 纯状态机，由会话事件 `tool/call` / `tool/result` / `turn/end` / PTC 对驱动）；账面非空时扣留判定放行（原生投递）；开账事件发现已有暂存批时，微任务逐条 `inject` 回 next-step。
3. **`heldKinds` 默认去掉 `agent-message`**：所有回复随时穿插——回到本插件要解决的注意力劫持问题（2026-08-25 事故）。
4. **仅旁路不回注**：消息恰在开账前窄窗口到达时（含 run_code 执行期整个 PTC 宽窗口）仍会漏——wait_agent 首查收件箱为空、干等超时。

## 决策

选 2。要点与时序论证（经独立评审核实，见 `.temp/review-wait-agent-bypass.md`）：

- **记账先于一切早退**：`session/event` 监听器对每个事件先跑 `applyWaitEvent`。开账事件（`tool/call` / `tool/ptc-dispatch-start` 且 `name === 'wait_agent'`）先于工具执行落日志，故消息到达时账面必然已开（主路径 T1）。
- **销账双保险**：`tool/result`（含 error / abort / 修复事件，`message.toolCallId` 同形）与 PTC 结算按 id 销账；`turn/end` 无条件清空兜底（wait 执行不跨 turn；turn 的 finally 一切终局都落账）。
- **回注必须微任务化**：开账事件在 `session.append()` 分发回调内被观察，同步 `inject()` 会触发 append 重入保护抛错、且被兜底分支静默吞掉（评审阻断项）。微任务内 append 已提交，合法。
- **回注时序不依赖排序**：wait_agent 官方实现先订阅 `agent/inbox/inserted` 后首查 `nextStep`——回注无论先于还是晚于首查，两个方向都能让等待 resolve。
- **逐条事务化**：回注成功一条移出暂存一条，任一失败即停、余量保留（退化为既有 idle / 放水阀释放）；条目清理由 identity 校验（`held.get(sessionId) === entry`）保证不与 valve/idle 释放双投。
- 不加配置项：不存在想要 wait_agent 说谎的合理部署；想要严格扣留的部署本就没有理由调用 wait_agent。

## 后果

- 正面：wait_agent 语义恢复（同轮见到所等正文）；无 wait_agent 时行为与 0.1.x 完全一致。
- 负面/已知限制：插件 HMR 卸载重载会清零账目——重载时仍在执行的 wait_agent，其后到达的消息回到扣留行为（= 0.1.x 现状，无害方向）；不重建账目（需扫描会话日志找未结算调用，复杂度不配此罕见场景）。wait_agent 开账后立刻失败（如超时参数非法）时，已回注消息在下一 step 边界被认领、同轮中段见到——等价原生忙时投递，可接受。
