# ADR-0002: 取出动作为什么推迟一个微任务

## 状态

accepted（2026-08-25）

## 背景

拦截监听器同步运行在 `session.append('agent/inbox/spliced', …)` 的事件分发内，而 `Inbox.mutate()` 的提交顺序是：**持久事件先落日志并分发，内存投影（`state` 数组）后变更**（`packages/core/agent/src/inbox.ts`，`mutate()` 中 `session.append` 先于 `inbox.splice`）。同步监听器里调 `inbox.remove(id)` 时，消息还不在内存投影里——`locate()` 找不到，remove 返回 false，等于没拦。

## 备选

1. **同步 remove**：如上，必然失败。
2. **监听 `agent/inbox/inserted`（活投影通知）再 remove**：该事件在投影变更**之后**发出，同步 remove 可行——但它走的是 `notifications.inserted` 分发（agent 作用域事件），且同样要先从 `session/event` 拿到 splice 上下文做 kinds 过滤，两套事件拼逻辑更绕。
3. **`Promise.resolve().then()` 推迟一个微任务**（本决策）：在当前同步执行栈（含 Inbox.mutate 的投影变更）完成后、任何宏任务（step 边界的 `Inbox.claim()`、工具执行、定时器）之前执行 remove。

## 决策

选 3。论证确定性：`Inbox.claim()` 只在 agent loop 的 step 边界被调用，从 splice 事件分发到下一次 claim 之间必然隔着至少一个宏任务边界（模型流回调/工具 await 的继续都是宏任务级调度），而微任务队列在当前宏任务结束前必然清空——所以 remove 一定先于任何后续 claim 执行。若认领确实先发生（理论上仅同一宏任务内再度 claim，现网路径不存在），remove 返回 false，退回原生行为，无害。

## 后果

- 正面：单事件流（只依赖 `session/event`）、时序论证封闭。
- 负面：正确性依赖 Node 的微任务/宏任务调度模型与 Inbox 的提交顺序不变；上游若把投影变更提前到事件分发之前，本插件退化为永久 no-op（remove 永远 false，原生行为保留）——安全失效方向。
