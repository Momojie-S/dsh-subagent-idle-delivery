# dsh-subagent-idle-delivery 设计总览

## 目标

后台 continuable 子 agent 的结算通知（`subagent-settled`）与对话回复在父会话忙碌时**不打断当前工作**：扣留到父会话完全空闲，再作为新回合投递。

回复载体随 DSH 版本变化：rc.2 时代是 report 工具的 `subagent-report`；`0.1.2-rc.1` steer 语义统一（#3250）删除 report 工具后，回复改由 `send_message` 发出、服务端派生 kind 为 `agent-message`——默认 `heldKinds` 三者全含，跨版本都拦得住。

## 非目标

- 不改动 DSH 运行时的投递逻辑——`notifySettlement()` 的 steer/followup 分发保持原样，本插件在**公共事件缝**（`agent/inbox/spliced`）上事后干预。
- 不拦截用户输入、steering、审批通知——只有显式配置的 `heldKinds` 命中才扣留。
- 不提供跨重启的扣留持久化——丢失语义与原生通知一致（尽力而为，子会话日志才是持久记录）。

## 工作原理

原生忙时投递是 `steer()`：通知进父会话收件箱 next-step 槽位，回合关闭前被整批认领，**延长当前回合一步**消化——模型注意力被劫持（2026-08-25 实测：两个 Edit 刚执行完，汇报混进下一步输入，原计划被丢弃）。

本插件的 hold-and-release：

1. **拦截**：监听全局 `session/event`，只看 `agent/inbox/spliced` 插入事件；`selectNotices()` 按 `heldKinds` 过滤出目标消息。父会话 idle 则放行（原生本来就是新回合）。
2. **取出**：推迟一个微任务后 `agent.inbox.remove(id)` 把消息取出发到进程内暂存表。必须推迟——Inbox 的持久事件**先落日志、后变内存投影**（`packages/core/agent-loop/src/inbox.ts`），同步监听器里 remove 找不到消息；而任何 step 边界的认领至少隔一个宏任务，微任务删除稳赢。`remove()` 走 `discarded` 通知，续管服务的 accepted 记账正确清理，不会让父会话被已删消息卡在 waiting。
3. **等待**：`agent.whenIdle()` resolve（父会话彻底停下）后 `followup()` 逐条重投——每条作为新回合。回合不再被通知延长，原来那步额外的模型请求也省掉。
4. **放水阀**：`maxHoldMs`（默认 10 分钟）兜底连续驱动的会话（goal 长会话可能数小时不空闲）。到期用 `followup()` 释放——忙时 followup 是**排队到当前回合之后**（next-turn 槽），依然不穿插进进行中的回合。
5. **退场**：插件停止时把暂存消息按同语义放回（followup）；父会话已死则丢弃并告警——与原生"投递失败只记日志"的丢失语义对齐。
6. **wait_agent 旁路**（0.2.0）：父会话自己正在执行 `wait_agent` 调用时（模型明确主动等输入），扣留判定放行——消息留在 next-step，工具返回 `timedOut:false`、step 边界认领，同轮见到正文。活跃账目由 `src/waits.ts` 纯状态机维护：开账（`tool/call` / `tool/ptc-dispatch-start` 且工具名为 wait_agent，先于工具执行落日志）、销账（`tool/result` / PTC 结算按 id，error / abort / 修复事件同形）、兜底（`turn/end` 无条件清空——wait 执行不跨 turn）。开账时若已有暂存批，微任务逐条 `inject` 回 next-step（同步 inject 会撞会话日志 append 重入保护）；回注时序不依赖排序——wait_agent 官方实现先订阅 `agent/inbox/inserted` 后首查 nextStep，两个方向都能 resolve。逐条事务化：任一条失败即停，余量保留既有释放路径。取舍见 [ADR-0003](./decisions/0003-wait-agent-bypass.md)。

## 边界与限制

- 扣留是进程内内存态：DSH 重启丢暂存消息（= 原生尽力而为语义，子会话日志仍是持久记录）。
- `whenIdle()` 的"idle"包含维护窗口（maintenance 在 status getter 里报 idle）——维护期间到达的通知原生就是 latch 到窗口结束，本插件在窗口结束后的空闲点投递，语义一致。
- 拦截在事件监听器里做事后 remove，与"消息已被认领"的竞态由"微任务 vs 宏任务"的时序差关闭；认领先发生则 `remove()` 返回 false，自然放行（退回原生行为）。
- 全链路异常围栏：同步守卫、微任务、定时器回调全部 try/catch + `.catch()` 兜底；hold 失败时把已取出消息 `inject` 放回，退回原生行为。任何错误不外逸（动态插件时代的进程击穿教训，见合集 `docs/research/subagent-settlement-delivery.md` 事故复盘；静态插件虽无进程击穿风险，围栏保留为退化保障）。
- wait_agent 账目是进程内内存态：插件 HMR 卸载重载会清零——重载时仍在执行的 wait_agent（超时上限 1 小时），其后到达的消息回到扣留行为（= 0.1.x 现状，无害方向）。不从会话日志重建账目（ADR-0003）。
- 插件停止/禁用期间一切消息走原生投递（wait_agent 语义完好），恢复后回到扣留——与 ADR-0001 的失效安全方向一致。
- compaction / maintenance 与账目无交互：maintenance 要求 idle 相位、与工具执行（running）互斥，维护期间不存在活跃 wait_agent；账目不落日志，compaction 重写历史不影响。

## 决策记录

- [0001-hold-at-inbox-seam.md](./decisions/0001-hold-at-inbox-seam.md) — 为什么选收件箱事件缝扣留，而不是 prompt 指令 / fork core / tool-jobs quiet 配置
- [0002-microtask-removal.md](./decisions/0002-microtask-removal.md) — 取出动作为什么推迟一个微任务
- [0003-wait-agent-bypass.md](./decisions/0003-wait-agent-bypass.md) — wait_agent 活跃时为什么旁路扣留并回注已暂存批（含回注微任务化与不依赖排序的时序论证）
