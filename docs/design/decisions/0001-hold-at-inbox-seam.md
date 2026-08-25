# ADR-0001: 在收件箱事件缝上扣留（hold-at-inbox-seam）

## 状态

accepted（2026-08-25）

## 背景

DSH 原生投递策略（`continuation.ts notifySettlement()`）：父会话忙时结算通知走 `steer()`，混进下一步输入批并延长当前回合。实测后果是注意力劫持——父模型把通知当紧急事，丢弃原计划。需求：通知等父会话完全停止才进入对话。

## 备选

1. **prompt 指令**（"收到通知先继续手头工作"）：零实现成本，但实测不可靠——模型在实践中就是会被汇报拉走（本次需求的直接动因）。
2. **fork core 改 `notifySettlement`**：语义最干净，但要维护对 `@deepseek-ai/dsh-subagent` 的 fork，上游每次升级需人工对齐；为一个投递策略背整个包的维护成本。
3. **tool-jobs `completionDelivery: 'quiet'`**：只作用于**空闲** owner（不开回合），忙时照样注入；且 jobs 体系与 continuable 结算是两条路径，覆盖不全。
4. **收件箱事件缝扣留**（本决策）：监听公共 `agent/inbox/spliced` 事件 + `inbox.remove()` / `followup()` 公共 API，零 fork、对上游升级免疫（API 面极小且稳定）。

## 决策

选 4。事后干预而不是改分发：原生 steer 落进收件箱后，插件在一个微任务内把它取出暂存，`whenIdle()` 后按 followup 重投。丢失语义与原生一致（内存态尽力而为）。

## 后果

- 正面：不 fork、升级免疫；原生路径完整保留（插件失效自动退回原行为）；忙时回合不再被延长，省一步模型请求。
- 负面：扣留消息不落日志（重启即丢，与原生尽力而为对齐）；依赖"微任务删除 vs 宏任务认领"的时序差（ADR-0002 论证其确定性）；`agent/inbox/spliced` 事件与 `inbox.remove()` 属于较底层 API，上游若改变 Inbox 提交顺序需重新验证。
