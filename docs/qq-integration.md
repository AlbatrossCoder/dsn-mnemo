# QQ 接入方案分析（含群聊）

> 结论：**QQ 接入应该是一个独立的「通道插件」，不是记忆插件的一部分。** 群聊要支持「谁说的」，通道必须能把 `userId/groupId` 放进消息的 `source`；外部 ACP 桥做不到这一点（ACP 不携带自定义来源元数据），所以群聊方案优先选**进程内通道插件**。

## 1. 边界

| 组件 | 职责 |
|---|---|
| `dsh-qq-channel`（新插件） | OneBot 连接、消息去重、@/关键词接话、合并去抖、会话映射、把回复发回 QQ、重连与限流 |
| `dsn-mnemo`（记忆插件） | L0 聊天记录（带说话人）、日记、锚点、关系阶段、检索与可见性过滤 |
| DSH 本体 | agent/session 生命周期、事件流、工具执行 |

## 2. 三种接入方式

### A. 进程内通道插件（推荐）

```
QQ ──OneBot WS──▶ dsh-qq-channel ──ctx.agents/agent.followup──▶ DSH session
                                       ▲                          │
                                       └──session/event(assistant)─┘──▶ 回发 QQ
```

- 通道作为 DSH 插件运行，用 `ctx.agents.create()/resume()` 按「群 / 人」建会话；
- 收到 QQ 消息后构造 `UserMessage`，`source` 里带 `{ kind: 'qq', userId, groupId }`，调用 `agent.followup()`；
- 监听 `session/event` 的 `assistant/message`，把可见文本回发到 QQ；
- 记忆插件的 recorder 从 `source` 取身份，写入 `speaker_id` / `audience`。

优点：身份完整、可复用 DSH 的会话/工具/持久化；缺点：依赖 DSH 插件 API（`ctx.agents`、`session/event`），需要注意版本兼容。

### B. 外部桥 + ACP

`dsh --profile acp` 提供 ACP（stdio JSON-RPC）接口，外部进程用 ACP SDK 创建会话、发送 prompt、接收更新。

- 适合：**私聊**——一个 QQ 好友对应一个 ACP session，身份隐含在会话里；
- 不适合：**群聊**——ACP 的提示词只有内容，不携带自定义 `source` 元数据，插件无法区分说话人；除非「一人一会话」（群里每人一个 session，桥自己做隔离），否则做不到群内归属。

### C. 外部桥 + headless 子进程

每条消息 `dsh headless --session-id <id> "..."`。简单、无状态依赖，但每次冷启动、延迟高、并发差，只适合低频私聊，不适合群。

### D. 在记忆插件里直接实现 QQ

不推荐：协议与记忆耦合，升级 OneBot 实现会牵动记忆核心，且记忆插件应保持「被动消费会话事件」。

## 3. 群聊的记忆粒度

群消息不一定都要触发模型轮次：

- **被 @ / 被回复 / 命中关键词**才唤醒 agent → 只有这些消息进入 L0，群记忆稀疏但成本低；
- **摘要轮（digest）**：通道把一段时间内的群聊合并成一次「群聊摘要」prompt 发给 agent，让记忆看到群体动态，成本可控；
- 「只记录不唤醒」需要 DSH 提供静默追加消息的能力，目前没有公开 API，暂不采用。

推荐 MVP：**@ 触发 + 可选 digest**（默认每 30 分钟或 50 条触发一次摘要轮），后续按实际群活跃度调。

## 4. 记忆插件要补的东西（v2）

独立于通道，`dsn-mnemo` 需要：

```sql
alter table sessions add column kind text not null default 'dm';  -- dm | group
alter table sessions add column audience_id text;                 -- user_id | group_id
alter table messages add column speaker_id text;
alter table diaries add column subject_kind text;                 -- user | group
alter table diaries add column subject_id text;
alter table diaries add column visibility text default 'public';  -- public | private | secret
alter table anchors add column subject_kind text, add column subject_id text;

create table persons (
  user_id text primary key,
  display_name text,
  relationship text default 'stranger',
  public_note text,
  first_seen text,
  last_seen text
);
```

配套：recall 按当前场景过滤；群聊返回「群记忆 + 说话人的 public/可暗示内容」，`secret` 永不出现；前置浮现群聊只用 public；关系阶段按 subject 计算。

## 5. 身份与隐私

- 通道负责把稳定身份（QQ 号、群号）放进 `source`；昵称只做展示；
- 群聊的聊天内容默认群可见（public），私聊默认 private；
- `private` 允许模型在群里暗示、不复述细节；`secret` 由判断模型标记，代码强制过滤；
- 群公告需说明聊天会本地落盘；提供「清空某人/某群记忆」的管理入口。

## 6. 工作拆分

| 阶段 | 内容 | 仓库 |
|---|---|---|
| 1 | v2 schema + recorder 身份 + recall 过滤 | dsn-mnemo |
| 2 | persons 层 + 三级可见性 + prompt 规则 | dsn-mnemo |
| 3 | OneBot 通道插件（连接、映射、回发、@ 判断） | dsh-qq-channel（新仓库/子包） |
| 4 | digest 摘要轮、限流、管理命令 | dsh-qq-channel |

## 7. 风险

- QQ 协议/账号风控：OneBot 实现（NapCat/LLOneBot）本身有限制，群消息频率高可能导致风控；
- 群规模：2000 人群只存一条群记忆 + 说话人标签，不建 2000 人档；
- 成本：每个 @ 触发一次模型轮次；digest 是控制成本的关键；
- DSH 多会话资源：群多时 agent/session 数量上升，需要上限与回收策略。

## 8. 待确认

1. OneBot 实现（NapCat / LLOneBot / 自研）与消息事件是否能拿到 `user_id`/`group_id`；
2. 群记忆粒度：只 @ 触发，还是加 digest；
3. 是否接受「群聊与私聊记忆严格隔离，只有公开内容可在群使用」；
4. 群规模与并发上限（决定会话/agent 的回收策略）。

确认后先做 `dsn-mnemo` v2（迁移草案 + 测试），再做通道插件；发布仍按「先测后发、先问再发」。
