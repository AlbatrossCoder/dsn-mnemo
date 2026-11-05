# 记忆系统规范（v3）

> 状态：原文、日记、锚点、当前画像已实现。记忆系统**不调用任何模型**——它只记录、存储、检索和提示；日记和画像由正在对话的主模型书写。
>
> 一句话：**三层记忆、两种主体（user / group）、同一套读写规则；差异只在身份来源与可见范围。**

## 0. 通道无关

记忆系统**不实现任何聊天协议**（QQ、Discord、微信都一样）。它只消费 DSH 的 `session/event`，并从消息的 `source` 读取身份：

```ts
source: { kind: 'qq', userId: '10001', groupId: '20002', mentioned: true }
```

- 有 `groupId` → `group:<groupId>` 主体；
- 只有 `userId` → `user:<userId>` 主体；
- 本地消息（`kind: 'user'`）→ `user:local`；
- 通道可以是一个独立插件、外部桥或别的实现，只要它把身份放进 `source` 并产生 session 事件。

因此 **QQ 通道不放在本仓库**；本仓库只保证这张「身份 + 事件」接口稳定。

## 1. 原则

1. **记忆按需使用**：话题检索相关才注入。新会话的头两轮改为按时间带这个主体最近的日记。画像每轮都带，因为看不出上下文是不是被截断了。
2. **主体隔离**：私聊记忆归 `user:<id>`，群聊记忆归 `group:<id>`；跨场景默认不互通。主体优先取这条消息的 QQ `source`，避免会话行还没写上时落到 `user:local`。
3. **日记由主模型书写**：可以记发生过的事，也可以记当时的反应和相处里的变化。记什么、写多长由模型判断。没有值得记的就不写。无条数上限。
4. **记忆系统不调用模型**：只做记录、存储、检索与提示，不自己生成内容。
5. **模型无状态**：所有上下文都由本系统显式注入，没有「模型自己记得」这回事。
6. **日期不做推断**：重复事件、日期都由模型在 `anchor_upsert` 时提供；记忆系统只存储与检索。

## 2. 主体与数据模型

```sql
sessions(id, kind 'dm'|'group', audience_id, created_at, last_active_at,
         last_turn_end_at, diary_judged_at)
messages(session_id, seq, turn, role, speaker_id, addressed,
         content, content_seg, created_at)
diaries(id, session_id, subject_kind, subject_id, content, importance,
        emotion, type_tags, visibility, created_at, updated_at)
anchors(id, subject_kind, subject_id, event_name, target_date, window_days,
        repeat 'none'|'daily'|'weekly'|'monthly'|'yearly', last_fired_on, handled_at, created_at)
persons(user_id, display_name, relationship, public_note, first_seen, last_seen)
portraits(subject_kind, subject_id, label, long_text, short_text, updated_at)
```

日记和锚点的 `subject_kind` 是 `user` 或 `group`。画像还有 `member`，id 形如 `群号:QQ号`。`persons` 仍只在遗忘时删除，没有写入。

主人的画像上限是长期 240 字、短期 120 字，其他人、群、群友是 120 / 60。超了不保存。`ownerId` 配置非空时用配置；否则在写入时读 `~/.dsh/whale-chat-state.json` 的 `ownerId`。

## 3. 三层记忆

| 层 | 内容 | 生命周期 | 检索 |
|---|---|---|---|
| L0 原文 | 聊天内容（人类消息 + 助手可见回复；群聊含 `speaker_id`、`addressed`） | 长期 | FTS5 + 字符兜底，按主体过滤 |
| L1 日记 | 第一人称、长度不限、重要度/情绪/可见性 | 长期 | BM25 + 重要度 + 近因 |
| L2 锚点 | 日期 + 事件名，可重复 | 长期 | 日期窗口匹配，注入上下文 |

L0、L1、L2 都不做自动过期删除。

## 4. 写入路径

| 触发 | 动作 |
|---|---|
| 每条消息 | 写 L0（人类 prompt + 助手可见文本；思考、工具调用与注入上下文不入库） |
| 主模型回复时 | 认为值得记，就 `diary_write` 写 L1；想更新当前画像就 `portrait_write` |
| 闲时 / 超长后 | 下一消息注入「待写日记」提示，主模型决定补写 L1 |
| 显式 `anchor_upsert` | 写 L2，主体 = 当前 user 或 group |

群聊只对 **addressed**（被 @ / 被回复 / 被提及）的内容写 L1；闲聊只进 L0。

## 5. 读取路径

### 私聊每轮

```
稳定前缀：规则（全局、字节稳定）
锚点上下文：这个人当天窗口内的锚点（按 agent 注入，每天一次）
工作记忆：DSH 会话历史（当前对话原文，插件不重复注入）
画像：这个人的当前长期 / 短期画像（有才带）
前置注入：新会话头两轮按时间带最近日记；之后才按最近话题段检索（过阈值才给，0..N 条）
按需工具：recall（scope=diary|log，限定 user 主体）
待写日记提示：闲时 / 超长后提醒补写
```

### 群聊被 @ 时

```
稳定前缀：规则（全局、字节稳定）
锚点上下文：这个群当天窗口内的锚点（按 agent 注入，每天一次）
工作记忆：DSH 群会话历史（通道决定其完整度）
画像：这个群，加上这一轮发送者里已经有画像的人；消息里点到的熟人群友再带一份
前置注入：新会话头两轮按时间带最近的公开日记；之后才按话题检索（自动注入只用 public）
按需工具：recall（scope=diary|log，限定 group 主体；secret 永不返回）
```

## 6. 关联检索（两种模式共用）

候选 = L1 日记（主体内）。

**查询构造**：取最近对话窗口（最多 16 条、300 字符），合并同一说话人的短句连发，按相邻消息的实词重叠切分话题；只取包含最后一条消息的话题段，段内实词（去停用词）作为查询；信号不足时向前继承一段。

**打分**：

```
score = 0.6 * 词面相关(fts bm25)
      + 0.25 * 重要性
      + 0.15 * 时间近
```

- 新会话的第 1、2 轮不走话题检索，按时间注入该主体最近的日记（群聊仍只要 `public`），这两轮不计入冷却。
- 从第 3 轮起，过阈值（默认 0.35）才注入；单次**上限 20 条且 ≤600 token**（先到先停）；**可以为 0**；
- 同一条记忆 **10 轮冷却**，避免注入区刷屏（会话历史仍负责连续性）；
- 关键词命中过多时，BM25 的 IDF 会自动降低常见词权重，普通记忆挤不进前列；
- 群聊自动注入只用 `public`；`private`/`secret` 留给模型主动 `recall` 或直接过滤。

## 6.1 时区

- 优先从模型侧带回来的时间信息（如用户消息 source 的 `clientTimeZone`、时间上下文）读取；
- 取不到时用本机本地时区；
- 锚点的 `target_date` 按该时区的「本地日」比较，避免跨时区把「今天」算错。

## 7. 锚点规则

1. **不做日期推断**：重复规则、日期都由模型在 `anchor_upsert` 时提供；记忆系统只存储。
2. **窗口检索**：`today ∈ [target_date - window_days, target_date + window_days]` 时命中（默认 2 天，可配）。
3. **重复事件**：`repeat` 非 `none` 时，按规则展开出临近的一次 occurrence，再套窗口；只做确定性计算。
4. **错过**：日期过了、既没提醒（`last_fired_on` 为空）也没处理（`handled_at` 为空），才算「错过」。
5. **浮现记录**：注入时写 `last_fired_on`，避免同一天重复提。
6. **可见性**：群锚点默认群可见；私聊锚点只在该用户私聊出现；私密日期只写 `user` 主体。

## 8. 可见性

| 级别 | 写入场景 | 群聊里 |
|---|---|---|
| `public` | 群里说过 | 可引用 |
| `private` | 私聊说过 | 可暗示，不复述 |
| `secret` | 明确秘密 | 硬过滤，永不出现 |

跨场景默认严格隔离：私聊记忆不进群，群记忆不进私聊。

## 9. 成本与节奏

- 记忆系统本身**零模型调用、零 token 成本**（只有本地 SQLite + FTS）。
- 日记由主模型在回复里顺带写，不额外增加模型调用。

## 10. 与旧版（v2）的差异

| # | 变更 |
|---|---|
| 1 | 删除 L2 记忆点层（短效记忆），四层改为三层 |
| 2 | 删除独立判断模型调用（`DiaryEngine` / `judge` / `diary_consolidate`） |
| 3 | 日记改由主模型书写，无条数、无长度上限 |
| 4 | 「闲时 / 长度」触发改为在下一消息注入「待写日记」提示 |
| 5 | `diary_write` 关联当前会话主体；schema 增加 `last_turn_end_at` |
