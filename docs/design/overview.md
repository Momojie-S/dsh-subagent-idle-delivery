# dsh-subagent-idle-delivery 设计总览

## 目标

后台 continuable 子 agent 的结算通知（`subagent-settled`）与主动汇报（`subagent-report`）在父会话忙碌时**不打断当前工作**：扣留到父会话完全空闲，再作为新回合投递。

## 非目标

- 不改动 DSH 运行时的投递逻辑——`notifySettlement()` 的 steer/followup 分发保持原样，本插件在**公共事件缝**（`agent/inbox/spliced`）上事后干预。
- 不拦截用户输入、steering、审批通知——只有显式配置的 `heldKinds` 命中才扣留。
- 不提供跨重启的扣留持久化——丢失语义与原生通知一致（尽力而为，子会话日志才是持久记录）。

## 工作原理

原生忙时投递是 `steer()`：通知进父会话收件箱 next-step 槽位，回合关闭前被整批认领，**延长当前回合一步**消化——模型注意力被劫持（2026-08-25 实测：两个 Edit 刚执行完，汇报混进下一步输入，原计划被丢弃）。

本插件的 hold-and-release：

1. **拦截**：监听全局 `session/event`，只看 `agent/inbox/spliced` 插入事件；`selectNotices()` 按 `heldKinds` 过滤出目标消息。父会话 idle 则放行（原生本来就是新回合）。
2. **取出**：推迟一个微任务后 `agent.inbox.remove(id)` 把消息取出发到进程内暂存表。必须推迟——Inbox 的持久事件**先落日志、后变内存投影**（`packages/core/agent/src/inbox.ts`），同步监听器里 remove 找不到消息；而任何 step 边界的认领至少隔一个宏任务，微任务删除稳赢。`remove()` 走 `discarded` 通知，续管服务的 accepted 记账正确清理，不会让父会话被已删消息卡在 waiting。
3. **等待**：`agent.whenIdle()` resolve（父会话彻底停下）后 `followup()` 逐条重投——每条作为新回合。回合不再被通知延长，原来那步额外的模型请求也省掉。
4. **放水阀**：`maxHoldMs`（默认 10 分钟）兜底连续驱动的会话（goal 长会话可能数小时不空闲）。到期用 `followup()` 释放——忙时 followup 是**排队到当前回合之后**（next-turn 槽），依然不穿插进进行中的回合。
5. **退场**：插件停止时把暂存消息按同语义放回（followup）；父会话已死则丢弃并告警——与原生"投递失败只记日志"的丢失语义对齐。

## 边界与限制

- 扣留是进程内内存态：DSH 重启丢暂存消息（= 原生尽力而为语义，子会话日志仍是持久记录）。
- `whenIdle()` 的"idle"包含维护窗口（maintenance 在 status getter 里报 idle）——维护期间到达的通知原生就是 latch 到窗口结束，本插件在窗口结束后的空闲点投递，语义一致。
- 拦截在事件监听器里做事后 remove，与"消息已被认领"的竞态由"微任务 vs 宏任务"的时序差关闭；认领先发生则 `remove()` 返回 false，自然放行（退回原生行为）。
- 全链路异常围栏：同步守卫、微任务、定时器回调全部 try/catch + `.catch()` 兜底；hold 失败时把已取出消息 `inject` 放回，退回原生行为。任何错误不外逸（动态插件时代的进程击穿教训，见合集 `docs/research/subagent-settlement-delivery.md` 事故复盘；静态插件虽无进程击穿风险，围栏保留为退化保障）。

## 决策记录

- [0001-hold-at-inbox-seam.md](./decisions/0001-hold-at-inbox-seam.md) — 为什么选收件箱事件缝扣留，而不是 prompt 指令 / fork core / tool-jobs quiet 配置
- [0002-microtask-removal.md](./decisions/0002-microtask-removal.md) — 取出动作为什么推迟一个微任务
