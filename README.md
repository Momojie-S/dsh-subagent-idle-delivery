# @momojie-s/dsh-subagent-idle-delivery

后台子 agent 的完成通知与主动汇报，在父会话**忙碌时先扣留**，等父会话**完全空闲后**作为新对话回合投递——不打断正在进行的工作，不劫持模型注意力。

## 环境要求

- DSH `>= 0.1.0-rc.7`（已验证至 `0.1.1-rc.2`；依赖 `agent/inbox/spliced` 事件、`Agent.inbox.remove()`、`Agent.whenIdle()/followup()/inject()`）
- 会用后台 continuable 子 agent 的部署（内置 `subagent` / `subagent_model` 的 `backgroundMode: continuable`、`schedspawn` 等都受益）

## 用法

挂载后无需任何操作。生效范围：

| 到达时机 | 行为 |
|---|---|
| 父会话空闲时 | 原生行为（立即开新回合处理）——不拦截 |
| 父会话忙碌时（模型输出/工具执行中） | **扣留**：消息从收件箱取出暂存，不再混进下一步输入，界面也不再闪排队预览；当前回合正常收尾后，暂存消息作为新回合投递 |
| 扣留超过放水阀时限仍未空闲 | 以"排队到当前回合之后"的方式释放（不穿插进进行中的回合，只排在它后面） |

拦截的消息类型默认两类：`subagent-settled`（后台子 agent 结算通知）与 `subagent-report`（子 agent 主动汇报）。用户消息、steering 插话、审批通知等一律不碰。

## 安装

```bash
dsh plugin --profile web add github:Momojie-s/dsh-subagent-idle-delivery
# 首次按 pnpm 提示在 profile 的 pnpm-workspace.yaml 加 allowBuilds 授权构建
```

本仓开发机：`dsh plugin --profile web add <本目录路径>`。重启 DSH 生效。

## 配置

patch `config` 字段：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `heldKinds` | string[] | `['subagent-settled', 'subagent-report']` | 拦截的 `source.kind` 列表。扩展前先确认目标类型的全部来源（如 `plugin` 包含审批/任务完成通知，加进去会连带拦掉） |
| `maxHoldMs` | number | `600000` | 放水阀：扣留超过该毫秒数仍未空闲则以排队方式释放；`0` = 严格扣留到空闲（连续驱动的 goal 会话可能长期不空闲，慎用 0） |

## 验证

verbose 日志出现激活行即挂载成功：

```
dsh-subagent-idle-delivery: active (kinds [subagent-settled, subagent-report], valve 600000ms)
```

全链路验证：让模型起一个后台子 agent（`run_in_background`），同时父会话继续干活；子 agent 完成时日志出现 `holding N notice(s) ... until idle`，而界面**不**出现子 agent 消息；父会话当前工作完整交付、回合结束后，子 agent 汇报才作为新回合出现（日志 `released ... (idle)`）。

---

设计取舍与机制详见 [docs/design/overview.md](./docs/design/overview.md)。
