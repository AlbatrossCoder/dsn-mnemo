# 记忆系统规范（v2 草案）

> 状态：设计定稿讨论稿，尚未实现。
>
> 一句话：**四层记忆、两种主体（user / group）、同一套读写规则；差异只在工作记忆来源、写入触发和可见范围。**

## 1. 原则

1. **记忆按需使用**：不设固定 token 预算；相关才注入，不相关就是 0 条。
2. **主体隔离**：私聊记忆归 `user:QQ号`，群聊记忆归 `group:群号`；跨场景默认不互通。
3. **宁缺毋滥**：日记只写值得记的；记忆点 7 天过期；判断模型可以拒绝写。
4. **模型无状态**：所有上下文都由本系统显式注入，没有「模型自己记得」这回事。
5. **日期不做推断**：重复事件、日期识别都由模型提供，记忆系统只存储与检索，不做 LLM 判断。

## 2. 主体与数据模型

```sql
sessions(id, kind 'dm'|'group', audience_id, created_at, last_active_at, diary_judged_at)
messages(session_id, seq, turn, speaker_id, addressed, content, content_seg, created_at)
memory_points(id, subject_kind, subject_id, kind, text, importance, created_at, expires_at)
diaries(id, subject_kind, subject_id, content, importance, emotion, type_tags, visibility, created_at)
anchors(id, subject_kind, subject_id, event_name, target_date, window_days,
        repeat 'none'|'daily'|'weekly'|'monthly'|'yearly', last_surfaced_at)
relation_state(subject_kind, subject_id, stage, score, updated_at)
persons(user_id, display_name, relationship, public_note, first_seen, last_seen)
```

`subject_kind` 只有 `user` 和 `group` 两种。

## 3. 四层记忆

| 层 | 内容 | 生命周期 | 检索 |
|---|---|---|---|
| L0 | 聊天内容（人类消息 + 助手可见回复；群聊含 `speaker_id`、`addressed`） | 长期 | FTS5 + 字符兜底，按主体过滤 |
| L1 | 日记（第一人称、重要度、情绪、可见性） | 长期 | BM25 + 重要度 + 近因 |
| L2 | 记忆点（一句话的小事/话题/待办） | **7 天**，重复/重要可晋升 L1 | 关联打分（词面 + 实体 + 时间模式） |
| L3 | 锚点（日期 + 事件名，可重复） | 长期 | 日期窗口匹配，注入稳定前缀 |

## 4. 写入路径

### user 模式

| 触发 | 动作 |
|---|---|
| 每条消息 | 写 L0（人类 prompt + 助手可见文本） |
| 空闲 ≥ `diaryIdleMinutes`（默认 20） | 日记判断 |
| 距上次判断 ≥ `diaryMaxTurns`（30 轮）或 ≥ `diaryMaxChars`（12000 字） | 日记判断 |
| 重要信号（生日/约定/离别/情绪等） | 立即日记判断 |
| 日记判断时 | 顺带产出 2–4 条 L2 记忆点（零额外调用） |
| 显式 `anchor_upsert` | 写 L3，主体 = 当前 user |

### group 模式

| 触发 | 动作 |
|---|---|
| 每条群消息 | 写 L0（含说话人、`addressed` 标记），**不唤醒模型** |
| 每 15 分钟或 100 条消息 | 速记员产出 3–5 条 L2 记忆点（只对活跃群） |
| 被 @ / 被回复 / 被提及 / 重要信号 | 日记判断（闲聊不触发） |
| 显式 `anchor_upsert` | 写 L3，主体 = 当前 group |

## 5. 读取路径

### 私聊每轮

```
稳定前缀：规则 + 这个人当天窗口内的锚点
工作记忆：DSH 会话历史
按需注入：关联检索（L2 记忆点 + L1 日记，过阈值才给，0..N 条）
按需工具：recall（scope=diary|log，限定 user 主体）
```

### 群聊被 @ 时

```
稳定前缀：规则 + 这个群当天窗口内的锚点
工作记忆：当前消息 + 被回复的那条（如有）
最近记忆点：时间模式（最近 30–90 分钟，按关联筛选）
按需注入：关联检索（L2 + L1，限定 group 主体 + 当前说话人的可公开内容）
按需工具：recall（scope=diary|log，限定 group 主体 + 说话人 visibility）
```

## 6. 关联检索（两种模式共用）

候选 = L2 记忆点（未过期） + L1 日记（主体内）。

打分：

```
score = 0.6 * 词面相关(fts bm25)
      + 0.2 * 时间近
      + 0.2 * 重要性
      + 实体命中加成（名字/书名/话题词）
```

- 过阈值才注入；单次**上限 20 条且 ≤600 token**（先到先停）；**可以为 0**；
- 时间模式：当前消息含「刚才/刚刚/最近」时，按时间取 30–90 分钟内的点，不要求词面匹配；
- 实体不足时用 `open_threads` 补充；
- 关键词命中过多时，BM25 的 IDF 会自动降低常见词权重，普通记忆挤不进前列。

## 6.1 时区

- 优先从模型侧带回来的时间信息（如用户消息 source 的 `clientTimeZone`、时间上下文）读取；
- 取不到时用本机本地时区；
- 锚点的 `target_date` 按该时区的「本地日」比较，避免跨时区把「今天」算错。

## 7. 锚点规则

1. **不做日期推断**：重复规则、日期都由模型在 `anchor_upsert` 时提供；记忆系统只存储。
2. **窗口检索**：`today ∈ [target_date - window_days, target_date + window_days]` 时命中（默认 2 天，可配）。
3. **重复事件**：`repeat` 非 `none` 时，按规则展开出临近的一次 occurrence，再套窗口；只做确定性计算，不做判断。
4. **错过**：`today > target_date + window` 且 `last_surfaced_at` 为空，检索到该锚点时返回 `missed=true`，模型可以表达「错过了」；超过 30 天仍未浮现则归档。
5. **浮现记录**：注入稳定前缀时写 `last_surfaced_at`，避免同一天重复提；也用于判断「是否错过」。
6. **可见性**：群锚点默认群可见；私聊锚点只在该用户私聊出现；私密日期只写 `user` 主体。

## 8. 可见性

| 级别 | 写入场景 | 群聊里 |
|---|---|---|
| `public` | 群里说过 | 可引用 |
| `private` | 私聊说过 | 可暗示，不复述 |
| `secret` | 明确秘密 | 硬过滤，永不出现 |

跨场景默认严格隔离：私聊记忆不进群，群记忆不进私聊。

## 9. 成本与节奏

- 私聊：每轮最多一次判断；记忆点搭车；
- 群聊：速记员 15 分钟/100 条（不回复）；日记仅 addressed；不 @ 的消息只写 L0；
- 无固定 token 预算，只有阈值与条数上限。

## 10. 一对一现有缺陷（需要补）

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 没有短效记忆（新会话/压缩后丢失最近几天） | 加 L2 记忆点，搭日记判断产出 |
| 2 | 前置浮现是规则触发 + 固定 top 3 | 改为关联打分 + 阈值，上限 20 条 / 600 token，0 条也正常 |
| 3 | 日记判断只看最近 12 条 | 长度触发时改为覆盖「上次判断以来」的对话（有界截断） |
| 4 | 无重复事件、无「错过」语义 | 锚点加 `repeat`、`last_fired_on`（提醒时间）、`handled_at`，`missed` 可推导 |
| 5 | 锚点没有浮现记录，可能重复或永远不提 | `last_fired_on` + 每日去重 |
| 6 | 关系阶段按会话算（已从规范删除） | 不存阶段；关系由日记/记忆量由模型判断 |
| 7 | 无可见性分级 | 加 `visibility` + 群聊过滤 |
| 8 | 检索纯词面 | 关联打分（词面 + 实体 + 时间） |
| 9 | 时区未明确 | 优先取模型侧时间，否则本地时区 |
| 10 | 缺按人/按群清理入口 | 管理工具 `mnemo_forget`（按主体清理） |

## 11. 未决

- 重复事件是否支持「每月最后一个周五」这类复杂规则（建议先不做）；
- `persons` 的 `relationship` 是否要允许手动设置；
- 群记忆的「错过」是否需要主动提醒（默认只在被问时体现）。
