# 多用户（QQ 群）适配分析

> 结论：**QQ 侧可以稳定辨别用户**（每一条群消息都带 `user_id`/`group_id`），但**当前插件没有接收身份**，且数据模型假设「一个会话 = 一个人」。直接接群聊会串记忆、并且有隐私泄漏风险。要适配，需要桥提供身份 + 插件加「主体」维度。

## 1. 先对齐 L0 的定位

L0 是**聊天记录**：人类说的话 + 鲸鱼娘的可见回复。思考过程、工具调用、工具结果、注入的运行时上下文都不属于 L0；L1 日记才是汇总与索引，承担长效记忆。多用户改造只改「聊天记录怎么归属」，不改这个分层。

## 2. QQ 侧：能不能辨别用户

取决于桥用的协议。主流 QQ 机器人框架（OneBot 11 / NapCat / LLOneBot / Lagrange）的事件里都有：

| 字段 | 稳定性 | 用途 |
|---|---|---|
| `user_id`（QQ 号） | **稳定**，跨群、跨昵称不变 | 记忆主体 id |
| `group_id` | 稳定 | 会话/群作用域 |
| `message_id` | 每条唯一 | 去重、回溯 |
| `sender.nickname` / `sender.card` | 可变（改昵称/群名片） | 仅展示，不作主键 |
| `time` | 消息时间 | 排序、补判 |

所以**可以辨别用户**。关键在于桥要把这些字段传进 DSH 的消息里。DSH 的 `MessageSource` 是 merge-extensible 的联合类型，桥可以带：

```ts
source: { kind: 'qq', userId: '123456', groupId: '7890', nickname: '…' }
```

但当前 recorder 只检查 `source.kind`（用来过滤注入上下文），**没有把 userId 落库**，所以信息在入库前就丢了。

## 3. 三种接入方案

### 方案 A：一人一个会话（桥改造，插件零改动）

群里 @ 鲸鱼娘时，桥按 `user_id` 路由到该成员的独立 DSH 会话；群消息只作为「当前输入」，不进共享记忆。

- 改动：只改桥；插件不用动。
- 优点：隐私边界最干净（每人只能召回自己的记忆）、关系阶段按人累计、实现最快。
- 缺点：群友之间没有共同记忆；会话数量 = 群成员数；桥要做会话生命周期管理。
- 适合：先上线验证，或鲸鱼娘主要做「私聊式陪伴」。

### 方案 B：一个群一个会话 + 说话人归属（插件改造）

群里共用一条 DSH 会话，但每条消息记录 `speaker_id`；记忆按「群共享 + 个人」两个可见性存储。

需要的 schema v2（草案）：

```sql
alter table messages add column speaker_id text;        -- 谁说的
alter table diaries  add column subject_id text;        -- null = 群共享
alter table diaries  add column visibility text default 'group'; -- group | private
alter table anchors  add column subject_id text;        -- null = 群共享
alter table sessions add column scope text;             -- 'dm' | 'group'
```

配套规则：
1. recorder 从 `message.source` 取 `userId` 写 `speaker_id`；
2. `recall` 默认过滤：`subject_id is null or subject_id = 当前说话人`，私密日记只在私聊/本人可见；
3. 前置浮现按「当前说话人」检索，而不是按会话最后一条消息；
4. 日记判断区分群共享事件与某人的私事，私事 `${subject_id}` 且 `visibility='private'`；
5. 锚点按 `subject_id` 过滤，避免 A 的纪念日出现在 B 面前；
6. 关系阶段拆成「群阶段 + 个人阶段」两张表或加 subject 维度。

- 优点：有共同记忆，也能保留个人线。
- 缺点：改造量最大；隐私规则必须写进代码（不能靠 prompt）；需要桥配合传身份。
- 适合：正式的群陪伴产品。

### 方案 C：方案 B 的完整版（共享 + 私密双层）

在 B 的基础上区分 `visibility`，并给 `recall` 增加显式的 `scope: 'group' | 'self'` 参数，由桥或模型决定。适合群里有明确「公开/私下」语义的场景。

## 4. 群会话的硬需求清单

| 需求 | 说明 |
|---|---|
| 身份 | 每条消息带稳定的 `user_id`；昵称只做展示 |
| 去重 | QQ 重连/重发时按 `message_id` 去重 |
| 接话策略 | 只在 @、被回复、或命中关键词时回复，否则会刷屏 |
| 合并去抖 | 多人同时说话时合并成一次模型轮次，避免每条消息触发一次请求 |
| 隐私声明 | 群内聊天会本地明文落盘，接入前需在群公告说明 |
| 按人清理 | 提供「清空某人的记忆」能力（`forget user <id>` 或管理脚本） |
| 成本控制 | 日记判断按会话计费，群越活跃成本越高；`diaryIdleMinutes` 与 `diaryMaxPerSession` 要按群规模调 |
| 关系阶段 | 按人累计，不能再用「会话」代替「人」 |

## 5. 推荐路线

1. **先让桥传身份**：消息里带 `userId`/`groupId`，并在入库前保留；
2. **短期用方案 A** 上线，零插件改动，先验证群聊体验与接话策略；
3. **中期做 schema v2**（speaker_id / subject_id / visibility / scope），把 `recall`、前置浮现、日记判断、锚点都按主体过滤；
4. **最后做管理面**：按人清空、按群统计、隐私开关。

## 6. 需要你确认的问题

1. 桥是自研还是现成框架（NapCat/LLOneBot）？消息事件里能拿到 `user_id` 吗？
2. 群聊希望「一人一会话」还是「一群一会话 + 共享记忆」？
3. 鲸鱼娘在群里是「被 @ 才说话」还是允许主动接话？
4. 群共享记忆的边界：哪些内容允许所有群成员看到？（决定 visibility 默认值）

确认后我出 v2 迁移与 `recall`/前置浮现的主体过滤实现；按新规矩，改完先测试、经你同意再发版。
