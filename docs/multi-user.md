# 多用户（QQ 群）适配分析

> 结论先行：**当前实现假设「一个会话 = 一个人」**。直接把鲸鱼娘接进 QQ 群会「能跑」，但记忆会混在一起、并且有隐私泄漏风险。要真正适配，需要先确定身份映射，再给存储加「说话人/主体」维度。

## 1. 现在的假设

| 位置 | 假设 | 群聊下的问题 |
|---|---|---|
| `sessions` | 一个会话对应一段对话，没有用户身份 | 群里所有人共用一条会话，`relation_stage` 变成「群关系」 |
| `messages` | 只有 `role`（user/assistant/tool），**不记录谁说的** | 无法回答「这是 A 还是 B 说的」 |
| `diaries` | 第一人称，隐含「和主人」的二人关系 | 日记会变成「群里发生了…」；人称、口吻失真 |
| `anchors` | 全局，没有归属 | A 的纪念日会浮现在 B 面前 |
| `recall` | 跨会话全局检索（日志排除当前会话） | 任何成员都能召回别人说过的原话 |
| 前置浮现 | 按 agent 注册，读该会话最新人类消息 | 群里最后说话的人决定浮现内容，其他人被忽略 |

DSH 侧：`MessageSource` 是可扩展的联合类型（`kind`）。QQ 桥完全可以在 `source` 里带 `{ kind: 'qq', userId, groupId }`，但**现在的 recorder 把 source 丢掉了**，所以身份信息在入库前就丢了。

## 2. 三种接入方案

### 方案 A：一人一个会话（改桥，不改插件）

QQ 桥为每个成员维护独立的 DSH 会话：群里 @ 鲸鱼娘时，把该成员的历史会话作为上下文。

- 优点：**零插件改动**，隐私边界天然清晰（每人只能召回自己的记忆）；
- 缺点：群里无法共享「共同经历」；会话数量 = 群成员数，资源占用高；群内多轮对话的上下文拼接要桥自己做；
- 适合：QQ 私聊为主，群聊只是「多人分别私聊」。

### 方案 B：一个群一个会话 + 说话人归属（改插件）

给记忆加「主体」维度：

```sql
-- v2 迁移（草案）
alter table messages add column speaker_id text;      -- 谁说的（QQ 号/群昵称稳定 id）
alter table diaries  add column subject_id text;      -- 这篇日记属于谁（null = 群共享）
alter table anchors  add column subject_id text;      -- 这个锚点属于谁
alter table sessions add column scope text;           -- 'dm' | 'group'
```

配套规则：

1. recorder 从 `event.data.message.source` 提取 `speaker_id` 入库；
2. `recall` 增加隐式过滤：默认只返回 `subject_id is null or subject_id = 当前说话人`；
3. 日记判断区分「群共享事件」与「某人的私事」，私事只写 `subject_id`；
4. 前置浮现按「当前说话人」检索，而不是按会话最后一条消息；
5. 锚点按 `subject_id` 过滤，避免 A 的纪念日出现在 B 面前。

- 优点：群聊有共同记忆，同时保留个人边界；
- 缺点：需要 schema v2 + recorder/recall 改造 + 桥配合传身份；隐私规则要在代码里强制，而不是靠 prompt。

### 方案 C：双层记忆（共享 + 私人）

方案 B 的完整版：每条日记带 `visibility`（`group` / `private`），私密日记永不进入群聊的浮现与召回；`recall` 的 scope 再加一个 `subject` 过滤参数。

## 3. 推荐路线

1. **先做桥的身份映射**：无论选哪种，桥都必须给出稳定的 `userId`（QQ 号）与 `groupId`；
2. **短期用方案 A** 上线，验证「多人群聊不串味」；
3. **中期做方案 B 的 v2 迁移**（speaker_id / subject_id / scope + recall 过滤），再做方案 C 的 visibility；
4. 隐私提示：群成员的聊天会被本地明文落盘，接入前要在群公告里说明；提供「按用户清空记忆」的管理命令。

## 4. 还要注意的非记忆问题

- 群里多人同时说话时，桥需要做消息合并/去抖，否则每个成员一句话都会触发一次模型轮次；
- 需要在桥层做「是否接话」的判断（被 @ 才回、或按频率回），否则鲸鱼娘会刷屏；
- 日记判断调用是每个会话一次，群聊高频时成本会上升，`diaryMaxPerSession` 与空闲时间要按群规模调整。

---

需要落地时，我可以先出 v2 迁移草案（不改现有数据），并在 `recorder`/`recall` 里加 `speaker_id` 的可选支持；等你确认桥的身份格式后再实施。
