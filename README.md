# dsn-mnemo

> 鲸鱼娘的**记忆运行时**。让「想起」发生在正确的时机，以正确的形态。

`dsn-mnemo` 是一个 DeepSeek Harness（DSH）插件。它**不负责人设**——人设由独立的 persona 插件或 preset 提供；它只做一件事：记录发生过什么、把值得留下的沉淀成日记、在合适的时候把对的事浮现进当前对话。

**当前状态**：调研完成，尚无实现代码。运行时能力已实测（见 [PLAN.md](PLAN.md)），开发计划与阶段验收标准也已在其中列出。

---

## 它要解决什么

一次对话结束后，上下文就被丢弃了。模型既不记得昨天聊过的话题，也不会在今天这个特殊的日子里主动提起什么——除非有人把记忆重新端到它面前。

`dsn-mnemo` 就是这个「端记忆」的基础设施：

- **留下痕迹**：完整消息落盘，不必依赖窗口内的对话历史；
- **主动沉淀**：在对话真正沉落之后（30 分钟无活动），判断这段交流是否值得写给「下一个自己」；
- **恰当地想起**：有线索时按需深掘，有话题跳跃时自动浮现，有纪念日时被锚点唤起。

## 核心特性

- **四层记忆**：L0 全量日志 → L1 日记 → L2 工作层 → L3 锚点，各层职责与存储策略分离；
- **三种回忆行为**：前置浮现（无需模型请求）、按需深掘（`recall` 工具）、锚点触发（日期窗口）；
- **缓存友好**：稳定前缀的字节不随每轮检索变化，动态记忆只走 `context()` 与工具返回；
- **混合检索**：日记走 FTS5 + 向量双路召回，RRF 融合；日志只走词面检索；
- **克制的日记写入**：空闲触发 + 极短判断调用 + 每会话上限，宁缺毋滥；
- **极严格的日记修改**：默认不改写历史，新认知靠新日记的 recency 覆盖旧认知；
- **零额外依赖**：单文件 SQLite（`sqlite3_simple` + `sqlite-vec`），无需外部向量库；
- **与人设解耦**：只接收一个可选的 `diaryPersonaHint`，不内置任何角色 prompt。

## 四层记忆

| 层级 | 内容 | 存储 | 检索方式 |
|---|---|---|---|
| **L0** 全量日志 | 每条 user / assistant / tool 消息 | `messages` + `messages_fts`（FTS5） | 词面检索，需精确线索 |
| **L1** 日记 | 第一人称、2–3 句、带重要度与情绪标签 | `diaries` + `diaries_fts` + `diaries_vec`（vec0） | 双路召回 + RRF 融合 |
| **L2** 工作层 | 会话元状态、关系阶段、最近 N 轮 | `sessions` / `work_state`（轮次直接查 `messages`） | 直接读取 |
| **L3** 锚点 | 纪念日等「到点就该被提起」的事 | `anchors` | 日期窗口匹配，注入稳定前缀 |

L0 刻意**不建向量索引**：词面检索更接近「需要想起准确的词才能找到」的真实体验，也构成了刻意的检索难度梯度。

## 三种回忆行为

1. **前置浮现**：用户消息含时间指代（「上次」「你还记得吗」）、话题跳转、或情绪信号明显时，检索 top 2–3 条日记与高重要度片段，渲染进动态上下文。不占用模型一次工具调用。
2. **按需深掘**：模型主动调用 `recall`。`scope=diary` 走向量语义检索（快），`scope=log` 走 FTS5 词面检索（慢，但能挖到原话）。
3. **锚点触发**：跨日时做一次 O(1) 查询，命中窗口内的锚点就以稳定文本注入，一天内字节不变。

## 架构一览

```
DSH 对话循环
   │
   ├─ systemPrompt.section()   ← 稳定前缀：记忆规则 + 当天命中的锚点
   ├─ systemPrompt.context()   ← 动态快照：前置浮现结果（每轮替换，不累积）
   ├─ tools                    ← recall / diary_write / anchor_upsert
   └─ hook: turn/end           ← 更新关系阶段、刷新 30 分钟空闲计时器
                                      │
                                SQLite：L0 / L1 / L2 / L3
                                FTS5(Jieba) + vec0 + RRF
```

关键约束：**稳定前缀的字节不随每轮检索结果变化**，否则前缀缓存失效。这也是把「浮现结果」放进 `context()` 而不是 `section()` 的原因。

## 快速开始

> 插件尚未发布，以下为目标使用形态。

```jsonc
// 插件配置块，字段对应 DESIGN.md §8 的 MnemoConfig
{
  "dbPath": "~/.dsh/mnemo/mnemo.db",
  "diaryIdleMinutes": 30,
  "diaryMaxPerSession": 3,
  "anchorWindowDays": 2,
  "contextRecallLimit": 3,
  "embeddingModel": "<你的 embedding 模型标识>",
  "diaryPersonaHint": "说话简洁，偶尔用「本鲸」自称"
}
```

## 内置工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `recall` | `query`、`scope: diary \| log`、`limit?` | 深掘记忆：日记走语义检索，日志走词面检索 |
| `diary_write` | 正文、`importance`、`type_tags` | 写入日记；工具内部会再做一次轻量判断，防止误写 |
| `anchor_upsert` | `event_name`、`target_date`、`window_days?`、`tone_hint?` | 录入锚点，MVP 阶段不做自动日期识别 |

## 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `dbPath` | `~/.dsh/mnemo/mnemo.db` | SQLite 单文件路径 |
| `diaryIdleMinutes` | `30` | 空闲多久后触发日记判断 |
| `diaryMaxPerSession` | `3` | 每会话日记上限，防止刷日记 |
| `anchorWindowDays` | `2` | 锚点前后各几天可触发 |
| `recallDiaryLimit` | `5` | `recall` 日记召回条数 |
| `recallLogLimit` | `5` | `recall` 日志召回条数 |
| `contextRecallLimit` | `3` | 前置浮现最多条数 |
| `embeddingModel` | — | 日记 embedding 使用的模型标识 |

## 关系阶段

不设硬性轮数阈值，由沉淀量驱动，每次 `turn/end` 后更新一次，不调用模型：

```
score = sessions_count + diary_count × 0.5
score < 5   → initial
score < 20  → familiar
score ≥ 20  → close
```

## 设计原则

- **宁缺毋滥**：日记只在空闲后判断一次（约 260 token 的短调用），值得才写；
- **历史不可随意改写**：日记修改只允许「用户明确纠正」与「锚点事实冲突」两种路径，且改前自动备份；
- **缓存优先**：任何每轮变化的内容都不允许进入稳定前缀；
- **难度梯度**：日志检索刻意比日记检索笨拙，模拟真实记忆的「越想越清楚」；
- **人设与记忆分离**：换人设不需要迁移记忆，换记忆实现不绑死人设。

## 路线图

- [ ] **Phase 1** 存储 + 工具骨架：建表、FTS5、vec0、`recall` 双路检索 + RRF
- [ ] **Phase 2** 稳定前缀 + 锚点：`section()` 注册、日期窗口检查、缓存命中验证
- [ ] **Phase 3** 前置浮现：触发条件、`context()` 注入、token 预算
- [ ] **Phase 4** 日记引擎：`turn/end` 钩子、空闲计时器、判断与写入、严格修改路径
- [ ] **Phase 5** 关系阶段 + 打磨：阶段计算、配置面板、边界测试

建议顺序即上表：先把「能检索、能锚点、能浮现」跑通，再上日记——日记最容易产生坏数据，放在后面可以避免早期数据污染。

## 项目结构（规划）

```
src/
  db/          schema, migrations, fts, vec
  store/       message-store, diary-store, anchor-store
  retrieve/    fts-search, vector-search, rrf
  inject/      stable-prefix, dynamic-context
  tools/       recall, diary-write, anchor-upsert
  hooks/       turn-end, idle-timer
  persona/     diary-prompt
```

## 文档

- [PLAN.md](PLAN.md) — 开发计划与交接：实测环境结论、架构定稿、P0–P6 阶段与验收标准、PC 端验证手册。
- [DESIGN.md](DESIGN.md) — 完整设计文档与技术方案：数据库 Schema、DSH 集成细节、检索融合公式、风险与验证点。

## 许可

[Apache License 2.0](LICENSE)
