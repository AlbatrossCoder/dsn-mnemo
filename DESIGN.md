
# dsn-mnemo · 设计文档与技术方案

**版本**：v1.0（可开发）
**目标运行环境**：DeepSeek Harness（DSH）插件
**存储底座**：SQLite（`sqlite3_simple` + `sqlite-vec`）
**中文分词**：Simple 分词器 + Jieba（`jieba_query` / `simple_query`）


## 1. 项目定位

`dsn-mnemo` 是鲸鱼娘的**记忆运行时**。它不负责人设本身（人设由独立 persona 插件或 preset 提供），只负责一件事：

> 让鲸鱼娘在正确的时机，以正确的形态，想起正确的事。

它管理四层记忆：**L0 全量日志 → L1 日记 → L2 工作层 → L3 锚点**，并通过三种回忆行为（前置浮现、按需深掘、锚点触发）把内容组装进当前对话。


## 2. 架构总览

```
┌─────────────────────────────────────────────┐
│              DSH 对话循环                     │
│  turn/start ──→ LLM 调用 ──→ turn/end        │
└───────────────┬─────────────────────────────┘
                │
    ┌───────────▼───────────┐
    │   dsn-mnemo 插件       │
    │                       │
    │  [注入层]              │
    │   systemPrompt.section │  ← 稳定前缀：规则 + 锚点（日期变时才变）
    │   systemPrompt.context │  ← 动态：前置浮现结果（每轮替换）
    │                       │
    │  [工具层]              │
    │   recall(query,scope)  │  ← 模型主动深掘
    │   diary_write(...)     │  ← 模型写日记（内部也可由 hook 触发）
    │   anchor_upsert(...)   │  ← 锚点录入
    │                       │
    │  [钩子层]              │
    │   turn/end ──→ 判断是否写日记 / 更新关系阶段
    │   定时器  ──→ 30 分钟无活动 → 写日记
    │                       │
    │  [存储层]              │
    │   SQLite: L0 / L1 / L2 / L3
    │   FTS5(Jieba) + vec0
    └───────────────────────┘
```

关键约束：**稳定前缀的字节不随每轮检索结果变化**，否则前缀缓存失效；动态记忆只放在 `context()` 注入点和工具返回中。


## 3. 数据库 Schema

单文件 SQLite，所有表共用一个数据库。以下是核心 DDL（字段设计为最小可用集，可在开发中增补）。

### 3.1 L0：全量消息

```sql
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  token_est   INTEGER,
  is_tool     INTEGER DEFAULT 0
);
CREATE INDEX idx_messages_session_time ON messages(session_id, created_at);

-- FTS5 虚表（Jieba 分词）
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content=messages, content_rowid=id,
  tokenize = 'simple'
);
-- 触发器：messages 插入/更新时同步 FTS
```

检索时使用 `WHERE messages_fts MATCH jieba_query(?)` 或 `simple_query(?)`。L0 **不建向量索引**——词面检索模拟“需要精确线索才能想起来”的深掘体验。

### 3.2 L1：日记

```sql
CREATE TABLE diaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content      TEXT NOT NULL,          -- 第一人称，鲸鱼娘口吻
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  importance   REAL DEFAULT 0.5,       -- 0~1，写入时判断
  emotion      REAL DEFAULT 0.5,       -- 0~1
  type_tags    TEXT,                   -- 逗号分隔：认知/经历/共鸣
  is_modified  INTEGER DEFAULT 0,
  modified_at  TEXT
);

-- FTS5
CREATE VIRTUAL TABLE diaries_fts USING fts5(
  content, content=diaries, content_rowid=id, tokenize='simple'
);

-- 向量（sqlite-vec）
CREATE VIRTUAL TABLE diaries_vec USING vec0(
  diary_id INTEGER PRIMARY KEY,
  embedding FLOAT[384]                 -- 示例维度，按实际 embedding 模型调整
);
```

日记同时有 FTS5 和向量索引，检索时两路召回 + RRF 融合。

### 3.3 L2：工作层（持久化原料）

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at     TEXT NOT NULL,
  relationship_stage TEXT DEFAULT 'initial'  -- initial / familiar / close
);

CREATE TABLE work_state (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id),
  last_anchor_date TEXT,
  turn_count       INTEGER DEFAULT 0
);
```

L2 的“最近 N 轮”不单独存储，直接从 `messages` 按 `session_id + created_at` 读取。`work_state` 只存元状态，**不存组装后的 prompt**。

### 3.4 L3：锚点

```sql
CREATE TABLE anchors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name  TEXT NOT NULL,
  target_date TEXT NOT NULL,          -- ISO 日期
  window_days INTEGER DEFAULT 2,      -- 前后几天可触发
  tone_hint   TEXT,                   -- “用怀念但不过分煽情的语气”
  is_recurring INTEGER DEFAULT 0,
  last_fired  TEXT
);
```

### 3.5 关系阶段

不设硬性轮数阈值。关系阶段由**已沉淀的日记数量 + 会话数**的轻量公式驱动：

```
sessions_count + diary_count * 0.5
  < 5   → initial
  < 20  → familiar
  ≥ 20  → close
```

每次 `turn/end` 后更新一次，不调用模型。


## 4. DSH 集成方案

### 4.1 稳定前缀：`systemPrompt.section()`

注册一个 **order 较早、字节稳定** 的 section，内容包含：

1. 记忆使用规则（“你有 L0 日志和 L1 日记，需要深掘时调用 `recall`”）；
2. **当天命中的锚点文本**（如果没有命中，这段为空字符串）。

锚点文本只在**日期变化且命中**时改变，其余时间字节不变，保证前缀缓存有效。

```ts
export const inject = ['systemPrompt', 'tools']

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'mnemo:rules',
    order: 30,
    text: () => buildStablePrefix(/* 读 anchors 命中结果 */)
  })
}
```

### 4.2 动态注入：`systemPrompt.context()`

前置浮现的结果放在 `context()`，而不是 `section()`。`context()` 的语义是“每轮可能变化的运行时快照”，DSH 会把它放在合适的位置，且**上一轮的 context 会被新快照取代**，不会累积。

触发条件（任一命中才检索）：
- 用户消息含时间指代（“上次”“之前”“你还记得吗”“那天”）；
- 与最近 3 轮的话题相似度低于阈值（话题跳转）；
- 用户消息情绪信号明显（可由轻量规则或 embedding 距离近似）。

命中后检索 L1 日记 + L0 中 `type_tags` 含“经历”且 `importance > 0.6` 的片段，取 top 2–3，渲染成一段带分隔标记的 context。

### 4.3 工具：`recall` / `diary_write` / `anchor_upsert`

```ts
ctx.tools.register(defineTool({
  name: 'recall',
  description: '深掘记忆。scope=diary 走向量语义检索（快）；scope=log 走 FTS5 词面检索（需要精确线索，慢）。',
  parameters: {
    query: { type: 'string', required: true },
    scope: { type: 'string', required: true, enum: ['diary', 'log'] },
    limit: { type: 'number' }
  },
  output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
  async execute(args, exec) {
    return scope === 'diary' ? searchDiaries(args.query, args.limit ?? 5)
                             : searchLogs(args.query, args.limit ?? 5)
  }
}))
```

`diary_write` 的 `description` 要明确告诉模型：**只有当你觉得这段经历值得留给下一个自己时，才调用它**。工具内部做一次轻量判断（见 5.1），防止模型滥用。

`anchor_upsert` 用于录入锚点。MVP 阶段由用户或模型在明确场景下调用，不做自动日期识别。

### 4.4 钩子：`turn/end`

监听 `turn/end` 事件，`reason` 为 `completed` 时触发两个轻量动作：

1. **关系阶段更新**：读 `sessions` + `diaries` 计数，更新 `relationship_stage`。
2. **写日记判断**：不立即写，而是**记录“本次 turn 结束后，启动/刷新 30 分钟空闲计时器”**。如果 30 分钟内没有新的 `turn/start`，计时器触发日记生成检查。

如果 `turn/end` 的 `reason` 是 `error` / `aborted`，不启动日记计时器——避免把失败的对话沉淀成日记。


## 5. 日记引擎

### 5.1 触发：30 分钟空闲

```
turn/end (completed)
  → 清除旧计时器，设新计时器 30min
  → 30min 内无 turn/start → 触发 diaryCandidate()
  → 有 turn/start → 取消计时器
```

`diaryCandidate()` 做一次**极短判断调用**（不注入完整记忆，只给最近这段会话的摘要和鲸鱼娘人设的一句话），问模型：

> “以鲸鱼娘的口吻，这段对话里有没有值得写给‘下一个自己’的事？有就写一篇 2–3 句的第一人称日记；没有就输出 `NO_DIARY`。”

这个模式在 `feiyu-memory` 里被验证过：每轮一次约 260 token 的判断，值得才固化。你的版本把“每轮判断”改成了“空闲后判断”，进一步降低调用频率。

如果判断为值得，**同一次调用直接产出日记正文**，减少一次往返。

### 5.2 日记写入

日记正文必须满足：
- **第一人称**（“本鲸今天……”或“今天主人……”）；
- **2–3 句**；
- 带一个 `importance` 自评（0–1）和 `type_tags`（认知/经历/共鸣）。

写入时同步生成 embedding，插入 `diaries` + `diaries_fts` + `diaries_vec`。

### 5.3 日记修改：极严格

修改只允许两种触发：

1. **用户明确纠正**：用户消息命中“你记错了 / 不是这样的 / 改一下日记”等模式，且模型判断确实需要改；
2. **锚点级事实变更**：日记内容与 L3 锚点的 `target_date` / `event_name` 发生冲突，且用户确认。

修改走 `diary_update` 工具，要求提供 `diary_id` 和修改理由，**修改前自动备份原内容到 `diary_revisions` 表**。其他情况一律不修改；新信息靠**新日记的 recency 权重**在检索中覆盖旧认知，而不是改写旧日记。


## 6. 锚点系统

### 6.1 触发窗口

每天首次加载或跨日时，执行一次 O(1) 检查：

```sql
SELECT * FROM anchors
WHERE target_date BETWEEN date('now', '-' || window_days || ' days')
                      AND date('now', '+' || window_days || ' days')
```

默认 `window_days = 2`，即**前后各 2 天都可触发**。命中后，把锚点渲染进稳定前缀，并更新 `last_fired`，同一锚点在一个窗口内只注入一次（可配置为“每天最多一次”）。

### 6.2 锚点文本形态

```
[锚点] 今天是你们相识纪念日的前一天。可以用稍微柔软一点的语气，但不要刻意煽情。
```

这段文本字节稳定（同一天内不变），放在 `section()` 里不会破坏缓存。


## 7. 检索与融合

### 7.1 日记检索：双路 + RRF

```sql
-- 词面路
SELECT diary_id, rank FROM diaries_fts
WHERE diaries_fts MATCH jieba_query(?)

-- 向量路（sqlite-vec）
SELECT diary_id, distance FROM diaries_vec
WHERE embedding MATCH ? AND k = 20
```

两路各取 top 20，用 **RRF** 融合：

```
score(d) = Σ 1 / (60 + rank_i(d))
```

融合后取 top-K。RRF 不需要归一化不同路的原始分数，天然避免“向量分数和 BM25 分数不可比”的问题。

### 7.2 日志检索：仅 FTS5

`recall(scope='log')` 直接走 `messages_fts MATCH jieba_query(?)`，按 `created_at` 加权（最近的略优先），但不做向量检索。这是刻意设计的**检索难度梯度**。

### 7.3 分类型权重（用于日记排序）

日记的 `type_tags` 影响融合后的最终排序：

| 类型 | 语义相关度 | 时间近因 | 重要性 | 情绪 |
|---|---|---|---|---|
| 认知 | 高 | 极弱 | 中 | — |
| 经历 | 中 | 中 | — | 中 |
| 共鸣 | 中 | 弱 | 低 | 高 |

实现上不必做复杂的加权求和，可以在 RRF 融合后，对“共鸣”类加一个小常数、对“经历”类的时间近因做轻度乘数。具体参数在开发中调。


## 8. 配置项（插件 Config）

```ts
interface MnemoConfig {
  dbPath?: string                    // 默认 ~/.dsh/mnemo/mnemo.db
  diaryIdleMinutes?: number          // 默认 30
  diaryMaxPerSession?: number        // 默认 3，防止刷日记
  anchorWindowDays?: number          // 默认 2
  recallDiaryLimit?: number          // 默认 5
  recallLogLimit?: number            // 默认 5
  contextRecallLimit?: number        // 默认 3（前置浮现最多条数）
  embeddingModel?: string            // 日记 embedding 使用的模型标识
}
```

所有配置通过 DSH 的 `Config` schema 声明，加载时校验。


## 9. 分阶段开发计划

**Phase 1：存储 + 工具骨架（可独立测试）**
- 建表、FTS5、vec0；
- `recall` 工具注册，双路检索 + RRF；
- 用静态测试数据验证 Jieba 检索和向量检索在目标平台上行为一致。

**Phase 2：稳定前缀 + 锚点**
- `systemPrompt.section()` 注册；
- 锚点表 + 日期窗口检查；
- 验证前缀缓存是否命中（通过 token 账单或响应延迟粗判）。

**Phase 3：前置浮现**
- 触发条件检测；
- `systemPrompt.context()` 注入；
- 控制 context 的 token 预算。

**Phase 4：日记引擎**
- `turn/end` 钩子 + 30 分钟计时器；
- 判断调用 + 写入；
- 日记修改的严格路径。

**Phase 5：关系阶段 + 打磨**
- 轻量阶段计算；
- 配置面板（如果做 client 侧）；
- 边界测试：空数据库、极长日志、无锚点、日记失败。

**建议顺序**：Phase 1 → 2 → 3 先跑通“能检索、能锚点、能浮现”，再上日记。日记是最复杂、最容易产生坏数据的部分，放在后面可以避免早期数据污染。


## 10. 关键风险与验证点

| 风险 | 验证方式 |
|---|---|
| `sqlite3_simple` 在 Windows 上 Jieba 词典加载行为 | Phase 1 在目标 Windows 版本跑一次中文 FTS5 冒烟测试 |
| `sqlite-vec` 的 `vec0` 虚拟表在 Flutter 桌面端的可用性 | Phase 1 验证 `vec0` 建表和 KNN 查询 |
| 前缀缓存是否真的命中 | Phase 2 对比“锚点文本变化前后”的 token 计费或响应时间 |
| 30 分钟计时器在 DSH 进程被杀死后丢失 | L2 的 `last_active_at` 已持久化，重启后按时间差补判；补判只写日记，不补前置浮现 |
| 日记判断调用产生意外 token 成本 | `diaryMaxPerSession` 硬上限 + 判断调用本身极短（约 260 token） |


## 11. 命名与模块划分

包名：`dsn-mnemo`。内部模块建议：

```
src/
  db/          schema, migrations, fts, vec
  store/       message-store, diary-store, anchor-store
  retrieve/    fts-search, vector-search, rrf
  inject/      stable-prefix, dynamic-context
  tools/       recall, diary-write, anchor-upsert
  hooks/       turn-end, idle-timer
  persona/     diary-prompt（日记判断与生成的 prompt 模板）
```

人设 prompt **不放在这个包里**——它属于 persona 层，`dsn-mnemo` 只接收一个可选的 `diaryPersonaHint` 字符串用于日记生成，保持记忆系统与人设的解耦。

