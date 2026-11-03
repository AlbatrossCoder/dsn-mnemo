# dsn-mnemo 开发计划与交接说明

| 项 | 值 |
|---|---|
| 状态 | 调研完成，**尚未开始编码** |
| 目标平台 | Windows PC（macOS 作为同构参考） |
| 调研环境 | macOS，DSH 0.2.1-rc.5 / Electron 44.7.0 / Node 24.21.0 |
| 依据文档 | [DESIGN.md](DESIGN.md)（技术方案）、[README.md](README.md)（对外说明） |
| 本文用途 | 换到 PC 后，按 §0 → §7 的顺序继续 |

---

## 0. 换到 PC 后怎么继续（约 30 分钟）

1. **跑能力探测**（§7.2）。这是唯一必须先做的事：记忆插件的地基是 SQLite + FTS5，Windows 版 DSH 若与 macOS 不同，§4 的架构要跟着改。
2. **对比基线**（§2）。不一致的地方以 PC 实测为准，把结果填进 §7.4 的表格。
3. **确认 3 个待决项**（§6）。不确认就按推荐执行。
4. **从 P0 开始**（§5）。P0 只做一件事：让一个空插件在真实 DSH 里被加载、被模型调用成功。

> ⚠️ 不要跳过 P0 直接写存储层。插件装载路径是整条链路上风险最高、最不可预测的一环，先打通它，后面每一步都能在真实环境里验收。

---

## 1. 目标与边界

**目标**：一个在 PC 桌面端 DSH 里可用的记忆插件，具备四层记忆（L0 日志 / L1 日记 / L2 工作层 / L3 锚点）与三种回忆行为（前置浮现、按需深掘、锚点触发）。

**成功判据**（三条，缺一不可）：
1. 跨会话：新会话能检索到旧会话的真实内容；
2. 不污染：稳定前缀字节不随每轮检索变化（缓存有效）；
3. 有节制：30 分钟空闲才写日记，且不写无意义的对话。

**非目标**（MVP 明确不做）：
- 不引入向量库/向量检索（原因见 §3）；
- 不做客户端 UI（无设置面板、无记忆浏览页）；
- 不做多 agent / 团队共享记忆；
- 不做锚点日期自动识别（由用户或模型显式录入）；
- 不做日记自动改写（只允许两种严格修正路径）。

---

## 2. 环境基线（macOS 实测）

### 2.1 版本

| 项 | 值 |
|---|---|
| DSH | 0.2.1-rc.5 |
| Electron | 44.7.0 |
| Node（Electron 内置） | 24.21.0 |
| SQLite（`node:sqlite`） | 3.53.4 |
| 独立运行时 Node | 24.21.0（`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`） |

### 2.2 能力

| 能力 | 结果 | 说明 |
|---|---|---|
| `node:sqlite` `DatabaseSync` | ✅ | 零原生依赖，DSH 自己也在用（`dsh-session-query-sqlite`） |
| FTS5 | ✅ | 可建虚拟表、`bm25()`、`snippet()` 正常 |
| `unicode61` 中文检索 | ❌ | 整句索引后 **0 命中**，中文必须预分词 |
| `trigram` 分词器 | ⚠️ | 可用，但**只支持 ≥3 字符**查询，2 字词（“难过”）无效 |
| `Intl.Segmenter('zh')` | ✅ | 分词质量可用：`今天|和|主人|聊|了|记忆|系统|的|设计` |
| 预分词列 + 外部内容 FTS5 | ✅ | 长查询、2 字查询、`bm25` 排序全部命中 |
| `vec0`（sqlite-vec） | ❌ | `no such module: vec0` |
| `loadExtension` | ✅ 方法存在 | 但需 `allowExtension` 构造，且要自备各平台原生二进制 |
| WAL 文件读写 | ✅ | 磁盘库可建、可写，`journal_mode=wal` |

### 2.3 关键结论

macOS 基线下，**“中文检索”必须靠 `Intl.Segmenter` 预分词 + FTS5**，不能依赖 SQLite 自带分词，也不能依赖 Jieba（运行时没有）。这套方案已实测跑通，且**零第三方依赖**——这是本项目能保持轻量的前提。

---

## 3. 必须修正的原方案假设

[DESIGN.md](DESIGN.md) 写于调研之前，以下 3 处与运行时不符，开发时以本表为准：

| # | 原方案假设 | 实测 | 定稿替代 | 影响 |
|---|---|---|---|---|
| 1 | `sqlite3_simple` 扩展 | 不存在；DSH 用 `node:sqlite` | `import { DatabaseSync } from 'node:sqlite'` | 存储层接口需重写（§4.1） |
| 2 | `sqlite-vec` 提供 `vec0` 做向量检索 | `vec0` 不可用；DeepSeek 侧也无 embedding 端点 | MVP **不做向量**，检索用 BM25 + 时间/重要度加权；预留 `EmbeddingProvider` 接口 | §7.1 的「双路 + RRF」推迟，日记写入不存 embedding |
| 3 | Jieba 分词器（`jieba_query`/`simple_query`） | 无 Jieba；`unicode61` 对中文 0 命中 | `Intl.Segmenter` 预分词列 + FTS5 外部内容表 | 分词在应用层完成，索引与查询必须用同一函数（§4.2） |

> 若 PC 上 `vec0` 意外可用，不要立刻改架构——先把 MVP 跑通，向量作为增量优化。

---

## 4. 架构定稿

### 4.1 存储

- 单文件 SQLite，`dbPath` 默认 `%USERPROFILE%\.dsh\mnemo\mnemo.db`；
- 开库即 `pragma journal_mode=wal`、`pragma foreign_keys=on`；
- 迁移用 `PRAGMA user_version` 递增，幂等；
- 表：`messages`（L0）、`diaries`（L1）、`anchors`（L3）、`sessions`/`work_state`（L2）、`diary_revisions`（修改备份）。

### 4.2 检索（已验证可用的写法）

每张需要检索的表增加 `content_seg` 列，写入时由应用层分词写入；FTS5 走外部内容表 + 触发器：

```sql
create table diaries(
  id integer primary key,
  content text not null,
  content_seg text not null,          -- 预分词结果，空格分隔
  created_at text not null default (datetime('now')),
  importance real default 0.5,
  emotion real default 0.5,
  type_tags text
);
create virtual table diaries_fts using fts5(
  content, content=diaries, content_rowid=id, tokenize='unicode61'
);
create trigger d_ai after insert on diaries begin
  insert into diaries_fts(rowid, content) values (new.id, new.content_seg);
end;
```

查询（**注意两个坑**）：

```sql
select d.id, d.content, bm25(diaries_fts) as rank
from diaries_fts join diaries d on d.id = diaries_fts.rowid
where diaries_fts match ?
order by rank;
```

- 坑 1：`bm25()` 的参数**必须写表名**，用别名会报 `no such column`；
- 坑 2：外部内容表不暴露业务列，取正文必须 join 回主表。

分词与查询共用同一个函数：

```ts
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
export const segment = (text: string) =>
  [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean).join(' ')
```

2 字词的召回只能靠分词表（trigram 无法覆盖 2 字符）。兜底顺序：

1. 主检索：分词表；
2. 若命中为空：对原查询做 `like '%词%'` 的候选过滤（`diaries.content like ?`，配合 `created_at` 限制近期范围），避免冷门词完全检索不到；
3. trigram 辅助表只在「≥3 字的新词/专名切分失败」时启用，作补充而非主力。

### 4.3 注入

- 稳定前缀：`ctx.systemPrompt.section({ name: 'mnemo:rules', order: 30, text: () => ... })`，只放记忆规则 + **当天命中的锚点**（无命中返回空串，段会被自动丢弃）；
- 动态内容：`systemPrompt` 的运行时上下文（`context`）承载前置浮现结果，每轮替换不累积；
- 铁律：任何每轮变化的内容都不许进 `section()`，否则前缀缓存从头失效。

### 4.4 事件

```ts
export const inject = ['tools', 'sessions', 'systemPrompt']   // 注意是 sessions，不是 session

ctx.on('session/event', (session, event) => {   // 回调是两个参数
  if (event.type !== 'turn/end') return
  const { turn, reason } = event.data
  if (reason.kind === 'completed') startDiaryTimer(session.id)
  else if (reason.kind === 'aborted') log('aborted by', reason.reason.kind)
  else log('failed', reason.error.message)
})
```

- `event.data.reason` 是判别联合：`{kind:'completed'}` / `{kind:'error', error}` / `{kind:'aborted', reason:{kind:'user'|'parent'|'disposed'|'hook'}}`——**没有顶层 `aborted` 字段**；
- 只有 `completed` 才启动日记计时，`error`/`aborted` 一律跳过；
- 取消息用 `session.deriveMessages()`（冻结的 `Message[]`），会话 id 用 `session.id`；
- L0 落库按 turn 批量提交，任何异常只记日志，**不得阻断对话**；
- 自定义事件类型不要往会话日志里 append：`KNOWN_SESSION_EVENT_TYPES` 之外的类型在恢复日志时会被拒绝。需要自己持久化的东西放本插件的 SQLite。

### 4.5 模型调用（日记判断）

```ts
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-account',   // 以 ctx.llm.listProviders() 实际值为准
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
})) { /* 累积 text-delta，finish 结束 */ }
```

判断 prompt 只给会话摘要 + 一句人设，要求输出 2–3 句日记或 `NO_DIARY`；单次约 260 token。

### 4.6 计时

`ctx.timeout(cb, ms)`（来自 `@deepseek-ai/cordis-plugin-timer`），随插件 fiber 释放自动清理。进程被杀会丢计时器，故 `sessions.last_active_at` 必须持久化，启动时按时间差补判（只补日记，不补前置浮现）。

### 4.7 安装与加载

插件是普通 ESM 包，**只导出命名成员**：`name`、`inject`、`Config`、`apply`。**不要加 `export default`**——Loader 的 `unwrapExports` 会取 `default` 并丢掉 `inject`，插件会因缺服务而永不启动。

开发期接入**不需要 pnpm、不需要改 profile 的 `package.json`**：patch 的 `insert` 条目支持绝对路径与 `file:` URL。

```yaml
# %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml —— 追加，别清空原内容
- insert:
    - id: dsn-mnemo
      name: "file:///C:/Users/you/Documents/Github/dsn-mnemo/lib/index.js"
      config:
        dbPath: "~/.dsh/mnemo/mnemo.db"
```

要让插件**源码**也热载（可选；默认只监视 patch 文件，不监视源码目录）：

```yaml
# 顶层再追加一条：覆盖已有 hmr 条目的配置（注意是整体替换，原字段要一并重述）
- id: hmr
  config:
    root: ["C:/Users/you/Documents/Github/dsn-mnemo"]
```

要点：
- 新插件用 **`insert:`** 形式；顶层 `id:` 形式是「覆盖某个已存在条目的 config」，写成顶层会得到「条目不存在」的 stderr 警告；
- patch 文件必须是合法 YAML 数组；**空文件或纯注释会让 DSH 启动失败**（要禁用该层请写 `[]`）——改前备份，改后确认能启动；
- 保存 patch 后 HMR 约 2 秒重新组合，通常无需重启；
- 插件里的裸导入（`@deepseek-ai/dsh-tools` 等）由启动器注入的 runtime resolution 解析，**本地目录插件不需要自带 `node_modules`**；
- `desktop` 是保留 profile，`dsh plugin --profile desktop` 会被 CLI 拒绝，只能手改 patch（或用 Settings 面板）；
- 发布形态（profile 依赖 `link:`/注册表、bundle 打包）放到 P6。

---

## 5. 阶段计划

每个阶段独立可验收，独立提交。

### P0 · 骨架 + 安装闭环（先做，风险最高）
- **任务**：TS 包结构（`src/` → `lib/`）、`package.json`（`name`+`version`+`type: module`+`main`）、最小插件（命名导出 `name`/`inject`/`apply`，注册 `mnemo_ping` 工具）；按 §4.7 写进 patch。
- **验收**：改完 patch 后 2 秒内（或重启后）GUI 里模型能调用 `mnemo_ping` 并拿到返回值；日志里能看到插件已挂载。
- **风险**：patch 写错会让 DSH 直接起不来 → 改前备份 patch；先只加 `insert` 一条，确认能启动再加第二项。

### P1 · 存储层
- **任务**：迁移框架 + §4.2 全部表与触发器 + `segment()` + 索引重建命令。
- **验收**：`node --test` 全绿，覆盖：迁移幂等、中文 2 字与多字命中、`bm25` 排序、索引重建、空库。
- **注**：单测依赖 `node:sqlite`，旧版 Node 需 `--experimental-sqlite`；直接用 DSH 自带 Node（24.x）最稳（§7.3）。

### P2 · 记录与 `recall`
- **任务**：`session/event` 采集 → L0；`recall(query, scope, limit)` 工具（`scope=diary|log`），BM25 + 时间近因 + 重要度。
- **验收**：真实会话里问“我们上次聊了什么”，模型能 recall 出上一会话的真实内容；失败时返回空而不是报错。

### P3 · 稳定前缀 + 锚点
- **任务**：`section()` 注册；`anchors` 表 + 日期窗口查询 + `last_fired` 去重；注入渲染。
- **验收**：同日连续两轮，渲染出的前缀字节完全一致；跨日且命中锚点时才变化，且一天只注入一次。

### P4 · 前置浮现
- **任务**：触发条件（时间指代正则 / 话题跳变 / 情绪词）→ 检索 top 3 → 上下文注入。
- **验收**：说“你还记得吗”时，不调工具也能带出相关日记；输出 token 有硬上限。

### P5 · 日记引擎
- **任务**：`turn/end` → 30 分钟计时；判断调用；写入（分词 + FTS）；`diaryMaxPerSession` 上限；`diary_update` 严格路径 + `diary_revisions`。
- **验收**：静置 30 分钟自动落一篇日记；杀进程重启后能补写；无意义对话不产生日记；修改需理由且留备份。

### P6 · 打磨 + 发布
- **任务**：关系阶段公式、全部配置项、边界测试（空库/超长日志/无锚点/LLM 失败/磁盘满）、README 更新、DESIGN.md 补「实现修正」章节、Windows 冒烟。
- **验收**：Windows 上从零安装 → 四层记忆跑通；卸载后无残留。

### 进度（2026-11-03，Windows 11）

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 | ✅ | patch `insert` 装载成功；桌面端模型调用 `mnemo_ping` 返回 `mnemo 0.1.0 ok (C:/Users/admin/.dsh/mnemo/mnemo.db)`；`scripts/harness-test.mjs` 在裸 Cordis + `ToolRuntime` 里注册并执行通过 |
| P1 | ✅ | `node --test "lib/**/*.test.js"` 15/15；覆盖迁移幂等、外键约束、2 字/多字中文命中、`bm25` 排序、索引重建、空库与纯标点查询 |
| P2 | ✅ | `session/event` → L0 落库、`recall` 双 scope 已实现；`scripts/harness-test.mjs` 用**真实 SessionStore** 驱动事件，L0 能落库并被 `recall` 命中；单测 29/29。桌面端需重启后才加载 0.2.0 |
| P3 | ✅ | `systemPrompt.section('mnemo:rules', order 30)` 稳定前缀 + `anchors` 日期窗口 + `anchor_upsert` 工具；harness 用真实 `systemPrompt.assemble()` 验证「同日两次结果字节一致」「锚点写入后出现」；单测 42/42。桌面端需重启后才加载 0.3.0 |
| P4 | ✅ | 触发规则（时间指代/情绪词）→ 日记检索 → 每 agent 的 `systemPrompt.context('mnemo:recall')`；harness 通过 `agent/created` 驱动，组装结果里出现浮现内容且同一轮内字节稳定；单测 51/51 |
| P5 | ✅ | 日记引擎：`turn/end(completed)` → 空闲计时 → 单次轻量判断 → 写入；`diary_write` / `diary_update`（严格理由 + `diary_revisions` 备份）；启动 `catchUp()` 补判。单测 70/70。真机 30 分钟静置与真实模型调用待重启后验收 |
| P6 | ✅ | 关系阶段公式落地（`turn/end` 更新）；README 重写为可安装版本；DESIGN 补「实现修正」；边界测试（超长对话 prompt 有界、空库、模型失败、无锚点）加入；单测 74/74。真机冒烟仍待重启 |
| 真机 0.6.1 | ✅ | 重启后装载成功：`mnemo_ping` 返回 `0.6.1`；系统提示出现 `mnemo:rules` 稳定前缀；L0 开始记录（181+ 条，实时增长）；`recall` 真机可用；`diary_consolidate` 真实调用了一次判断（模型返回无值得写的结论，无异常）；`diary_write` 写入 + FTS 命中 + 删除清理均验证 |

实现备注（真机验收期间确认）：

- **HMR 的模块命名空间缓存按插件名而不是 URL**：把 entry 的 `name` 改成 `file://.../index.js?v=N` 只会更新该条目的配置，**不会重新导入代码**（实测：`?v=11/12` 的配置生效了，但运行的仍是旧构建，新增的诊断日志始终不出现）。要换代码只能重启 DSH，或者换一个插件名（会破坏 entry 身份）。
- **空闲计时链路已在真机验证**：把 `diaryIdleMinutes` 临时设为 `0` 后，`turn/end` 结束几秒内 `sessions.diary_judged_at` 自动前进（不必手动调用），说明「定时器 → flush」在桌面端成立；flush 内部的真实模型调用与写入此前已由 `diary_consolidate` 与 `diary_write` 分别验证。
- `package.json` 必须是**无 BOM 的 UTF-8**：带 BOM 时 DSH 读取包清单失败并把插件行静默禁用（桌面端表现为完全不加载）。
- `recall` 的输出 schema 与返回对象不一致（返回带 `id`，schema 未声明）会触发 `additionalProperties: false` 校验错误；已在 schema 中声明 `id`，并用 DSH 自带的 `validateJsonSchemaValue` 锁定返回字段集合。
- 本插件同时是**可安装的组合包**：`cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch`；用临时 profile（`dsh.profile.bundles: ["@deepseek-ai/dsh-base", "dsn-mnemo"]`）`--dump-config` 已验证能组合出 `- id: dsn-mnemo` 行，市场索引样例也能通过 DSH 的 `parseMarketIndex` 校验。

实现备注（P6 期间确认）：

- **HMR 只能重载「配置树」，不能重载插件源码**：改 profile patch 会触发重组，但改 `lib/index.js` 不会让已加载的模块重新导入——loader 按 entry 名称缓存模块命名空间，同一 `file://` 路径再次挂载会复用旧命名空间。`hmr.root` 要**重启后**才生效。所以开发期改代码必须重启 DSH，或用 `scripts/harness-test.mjs`（可直接用 DSH 自带 Electron 运行）验证。
- 插件 apply 抛错在桌面端没有可见日志；已在 `apply` 外层加 `~/.dsh/mnemo/last-error.log` 记录（仅在失败时写），方便重启后定位装载问题。
- 实测：`scripts/harness-test.mjs` 在 **DSH 自带 Electron 运行时**里跑通（同一套 `node:sqlite`、同一批服务），五个工具注册、事件链路、稳定前缀、前置浮现全部通过。
- **补判去重**：`sessions.diary_judged_at` 记录上次判断时间，`catchUp()` 只处理 `last_active_at > diary_judged_at` 的会话；判断调用前先写标记，provider 故障不会让每次重启都重判同一段对话。
- **日志检索也补了字符兜底**：`recall(scope=log)` 与日记共用 `db/char-search.ts` 的实义汉字匹配，避免「看海 / 看了海」在 L0 里 0 命中。

实现备注（P5 期间确认）：

- 计时器用进程内 `setTimeout`（`timer` 服务不在 `inject` 里，避免多一个硬依赖），`dispose()` 统一清理；进程被杀靠 `sessions.last_active_at` + 启动 `catchUp()` 补判（只补 30 分钟内到 30 天之间的会话）。
- 判断调用输出用文本头（`IMPORTANCE` / `EMOTION` / `TAGS` + 正文）而不是 JSON：解析失败一律不写，杜绝坏数据。
- 真机默认走 `deepseek-account` / `deepseek-flash`，可用 `diaryProvider` / `diaryModel` 覆盖；无头模式因账号鉴权拿不到同一条路，所以日记链路的真实验收只能在桌面端做。
- `diary_update` 强制要求 `reason`（≥4 字）与存在的行，先把旧正文写进 `diary_revisions` 再改写，FTS 由 `content_seg` 更新触发器跟随。


实现备注（P1 期间确认）：

- `Intl.Segmenter('zh')` 对常见词（记忆/系统/难过）切分正确，但会把部分词切开（如「插件」→`插 件`、「本鲸」→`本 鲸`）。因为索引与查询共用同一函数，检索仍然可用；P2 评估召回质量时再决定是否补 bigram 兜底。
- FTS5 外部内容表的 `rebuild` 命令会去读未分词的 `content` 列，**不可用**；`rebuildIndexes()` 改为 `delete-all` + 从 `*_seg` 列重灌。

实现备注（P2 期间确认）：

- `user/message` 事件载荷就是 `UserMessage` 本身，**不带 turn**；turn 只能靠 `turn/start` 事件在内存里跟踪，进程重启后旧会话的 turn 会回落到 0。
- L0 用 `(session_id, seq)` 唯一约束去重：同一事件被重放（HMR、恢复）不会重复入库。
- 只记 `user/message`、`assistant/message`、`tool/result`；`system/message` 与 `developer/message` 不算记忆，reasoning 块也不入库。
- 无头模式（`dsh headless`）跑不了 `deepseek-account` 提供商（`ACCOUNT_SIGN_IN_REQUIRED`，需要 API key），所以**真实模型端到端只能在桌面端验收**；无模型链路用 `scripts/harness-test.mjs` 验证。

实现备注（P4 期间确认）：

- 中文分词是**精确词**匹配：日记里「看了海」切出 `看了` + `海`，查询「看海」切出 `看海`，词面对不上 → FTS 0 命中。已加字符级兜底（≥2 个实义汉字命中，按命中数与时间排序）。P5 写日记后召回质量依赖这个兜底。
- `systemPrompt.context()` 的 provider 拿不到会话对象，所以按 agent 注册：根上下文监听 `agent/created`（无标签监听器是全局的），在 `agent.ctx` 上注册 `mnemo:recall`；provider 闭包读取该 agent 的最新人类消息，并按消息 id 记忆结果，保证同一轮多步字节一致。
- 触发规则只做「时间指代 / 情绪词」两类；话题跳变需要 embedding，MVP 不做（DESIGN §4.2 的第三条留到后续）。

---

## 6. 待决 3 项

| # | 决策 | 选项 | 推荐 |
|---|---|---|---|
| 1 | 向量检索 | A 纯 FTS，接口留空 / B 接 OpenAI 兼容 embedding + JS 暴力余弦 / C 带 sqlite-vec 原生二进制 | **A** |
| 2 | 界面 | A 纯后台 / B 加设置面板与记忆浏览 | **A** |
| 3 | 平台验证节奏 | A 先 macOS 通、Windows 放 P6 / B 每阶段双跑 | **A**（当前已在 macOS 调研，PC 为交付目标） |

未确认前按推荐值推进；任一项改选 B/C，P1 与 P6 的工作量会显著增加，需重新估时。

---

## 7. PC 端验证手册

### 7.1 定位安装与 profile

```powershell
# DSH 安装位置（找到 app.asar 的父目录即可）
@("$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}") |
  ForEach-Object { Get-ChildItem $_ -Recurse -Filter app.asar -ErrorAction SilentlyContinue } |
  Select-Object -First 5 FullName

# DSH 用户目录
Get-ChildItem "$env:USERPROFILE\.dsh" -Directory
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"   # P0 要改的就是它，先备份
Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes" -Recurse -Filter pnpm.mjs |
  Select-Object -First 3 FullName
```

### 7.2 跑能力探测

```powershell
$exe = "C:\Path\To\DeepSeek Harness.exe"     # 用 §7.1 找到的 exe
$env:ELECTRON_RUN_AS_NODE = "1"
& $exe ".\scripts\probe-runtime.mjs" | Tee-Object -FilePath probe.txt
```

预期与基线（macOS）一致：`node:sqlite` / FTS5 / 预分词检索链路 PASS，`vec0` FAIL（**属正常**）。把 `probe.txt` 回填到 §7.4。

> 中文输出若乱码，先 `chcp 65001`，或直接看 `probe.txt`。

### 7.3 单测运行环境

单测需要 `node:sqlite`（Node 24 无标志启用，22.x 早期版本要加 `--experimental-sqlite`）。用 DSH 自带 Node，不要用系统 Node：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --test lib\**\*.test.js
```

（路径以 §7.1 实际结果为准；系统 Node 若为 24.x 亦可。）

### 7.4 回填表（PC 实测）

> 实测日期 2026-11-02，Windows 11 x64，用 DSH 自带 Electron 跑 `scripts/probe-runtime.mjs`
> （`ELECTRON_RUN_AS_NODE=1`）。探针汇总：**9 PASS / 10 项**，唯一 FAIL 是预期的 `vec0`。

| 检查项 | 基线（macOS） | PC 实际 | 一致？ |
|---|---|---|---|
| DSH 版本 | 0.2.1-rc.5 | 0.2.1-rc.5 | ✅ |
| Electron / Node | 44.7.0 / 24.21.0 | 44.7.0 / 24.21.0 | ✅ |
| SQLite 版本 | 3.53.4 | 3.53.4 | ✅ |
| `node:sqlite` 可导入 | ✅ | ✅ | ✅ |
| FTS5 | ✅ | ✅ | ✅ |
| 预分词 + FTS5 检索链路 | ✅ | ✅（长查询 1 命中 / 2 字 1 命中 / bm25 正常） | ✅ |
| `Intl.Segmenter` 中文 | ✅ | ✅（`今天\|和\|主人\|聊\|了\|记忆\|系统\|的\|设计`） | ✅ |
| `vec0` | ❌ | ❌（`no such module: vec0`） | ✅（与预期一致） |
| WAL 磁盘库 | ✅ | ✅（`journal_mode=wal`） | ✅ |
| profile 目录名 | `desktop` | `desktop` | ✅ |
| pnpm 路径 | `…/dependencies/pnpm/bin/pnpm.mjs` | 同路径，v11.28.5 | ✅ |
| patch `insert` + `file://` 能加载插件 | 未测（P0 验证） | 未测（待 P0） | — |
| HMR 对 patch 的生效延迟 | 文档称约 2 秒 | 未测 | — |

**其余环境事实（PC，2026-11-02）**

- 系统 PATH 里**没有** `node` / `npm` / `git`；可用的替代：
  - Node 24.21.0：`%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  - pnpm 11.28.5：同目录 `…/dependencies/pnpm/bin/pnpm.mjs`
  - git 2.56：`%LOCALAPPDATA%\GitHubDesktop\app-3.6.10\resources\app\git\cmd\git.exe`
- npm registry 可达；`@deepseek-ai/*@0.2.1-rc.5` 已发布（`next` tag，`latest` 是旧的 0.0.1-rc.1，**装依赖要显式写版本**）。
- 已实测：`pnpm add -D @deepseek-ai/dsh-tools@0.2.1-rc.5 @deepseek-ai/cordis@4.0.5 @deepseek-ai/schemastery@3.18.5 typescript` → `tsc` 编译一个含 `defineTool` + `Config` 的最小插件通过，产物无 `export default`；`node --test` + `node:sqlite` + FTS5 通过。
- DSH 的插件 API 文档与 `.d.ts` 全在 `app.asar` 内（`dsh/node_modules/@deepseek-ai/<pkg>/README.zh.md`），可用附录 A 提取，无需外网。
- 注意：Electron 是 GUI 子系统程序，PowerShell 直接 `&` 调用拿不到 stdout，要用
  `Start-Process -Wait -RedirectStandardOutput/-RedirectStandardError`（本次探针即如此运行）。

不一致时的处置：版本差异不影响架构；**只有 `node:sqlite` / FTS5 / `Intl.Segmenter` 三项失败才需要改方案**，此时先在本文档记录，再讨论退路（退路顺序：trigram 兜底 → 自带 better-sqlite3 → 放弃 FTS 改内存索引）。

---

## 8. Windows 差异清单

| 差异 | 影响 | 对策 |
|---|---|---|
| 路径分隔符 | SQL/日志路径拼接 | 全程 `path.join`，不手写 `/`；`dbPath` 支持 `~` 展开 |
| SQLite 文件锁 | Windows 上文件被占用时无法替换/删除 | 迁移在同连接内执行；备份用 `VACUUM INTO`；不做「复制覆盖 db 文件」 |
| 进程终止 | 计时器随进程丢失 | `last_active_at` 持久化 + 启动补判（§4.6） |
| 杀软 / 同步盘 | 数据库文件被扫描或同步 | 默认放在 `.dsh`（非 OneDrive）；文档提示不要放进同步目录 |
| 编码 | PowerShell 中文输出乱码 | 源码 UTF-8 + LF；输出重定向到文件再读 |
| 文件监听（HMR） | 编辑器原子写可能触发不了重载 | HMR 不生效就重启，不作为验收依赖 |
| `node.exe` 路径 | 单测跑错运行时 | 用 DSH 自带 Node（§7.3） |

---

## 9. 风险登记册

| # | 风险 | 概率 | 影响 | 对策 | 验证阶段 |
|---|---|---|---|---|---|
| 1 | 树外插件无法被 desktop profile 加载 | 低 | 高 | 用 `file://` + `insert` 接入；退路为独立 profile | P0 |
| 2 | PC 上 `node:sqlite`/FTS5 行为不同 | 低 | 高 | §7.2 探测；三项硬指标 | P0 前 |
| 3 | `Intl.Segmenter` 对专名/新词切分差 | 中 | 中 | trigram 辅助列兜底；检索结果可用性抽检 | P1 |
| 4 | 日记判断调用产生意外成本 | 中 | 中 | `diaryMaxPerSession` 硬上限 + 可整体关闭 | P5 |
| 5 | 热重载导致工具重复注册、计时器泄漏 | 中 | 中 | 全部挂在 fiber 上随 dispose 释放 | P0/P3 |
| 6 | patch 写错或写空导致 DSH 启动失败 | 中 | 高 | 改前备份；先只加一条 `insert`；禁用写 `[]` 而非留空 | P0 |
| 7 | 记忆库含隐私内容 | — | 高 | 纯本地明文，`dbPath` 可配置，提供清空命令，文档明示 | P6 |

---

## 10. DSH API 速查

| 需求 | 包 | 入口 |
|---|---|---|
| 稳定前缀 / 动态上下文 | `@deepseek-ai/dsh-system-prompt` | `ctx.systemPrompt.section({ name, order, text })` / `.context({ … , required? })` |
| 注册工具 | `@deepseek-ai/dsh-tools` | `defineTool({ name, description, parameters, output, execute })`（`parameters` 是「字段名→schema」映射） |
| 会话事件 | `@deepseek-ai/dsh-session` | `ctx.on('session/event', (session, event) => …)`，服务名 `sessions` |
| 插件配置 | `@deepseek-ai/schemastery` | `export const Config = z.object({ … })`，`import z from '@deepseek-ai/schemastery'` |
| 模型调用 | `@deepseek-ai/dsh-llm` | `ctx.llm.stream({ provider, model, messages })` + `BlockAssembler` |
| 计时器 | `@deepseek-ai/cordis-plugin-timer` | `ctx.timeout(cb, ms)` / `ctx.interval` |
| 插件装载 | patch 层 | `cordis.patch.yml` 的 `insert` + `file://` 路径（§4.7） |

三个易踩的坑：插件不得有 `export default`；`bm25()` 要写表名；patch 文件不能为空。

文档在 DSH 安装目录的 `app.asar` 内（路径形如 `dsh/node_modules/@deepseek-ai/<包名>/README.zh.md`），提取脚本见附录 A。

> **`app.asar` 是什么**：Electron 的应用打包归档（作用类似 tar），DSH 的全部代码与内置插件都封装在里面。它属于 **DSH 安装目录**，不属于本仓库，也不要复制进来（macOS 上约 174 MB）。
> - macOS：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
> - Windows：在安装目录的 `resources\` 下，常见 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\`，用 §7.1 的命令定位
> - 浏览方式：7-Zip 直接打开（原生支持 asar），或用附录 A 的脚本提取
>
> 本项目的代码不依赖它，只是**插件 API 的唯一可信文档来源**（DSH 目前没有公开的插件开发文档站点）。

---

## 11. 第一个 commit 清单

```
package.json       name=dsn-mnemo, version=0.1.0, private=true, type=module,
                   main=lib/index.js, exports={".": "./lib/index.js"},
                   peerDeps: @deepseek-ai/{cordis,schemastery,dsh-session,dsh-system-prompt,dsh-tools}
                   scripts: build(tsc) / test(node --test)
tsconfig.json      target ES2022, module NodeNext
src/index.ts       export const name = 'mnemo'
                   export const inject = ['tools', 'sessions']
                   export const Config = z.object({ dbPath: z.string().default('~/.dsh/mnemo/mnemo.db') })
                   export function apply(ctx, config) { ctx.tools.register(defineTool(mnemo_ping)) }
                   // 不要写 export default
scripts/probe-runtime.mjs   已就绪（本仓库）
README.md          安装与状态说明（P0 完成后补）
```

P0 的第一条命令是备份 patch，不是写代码：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" `
          "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak"
```

---

## 附录 A · 从 asar 提取 DSH 文档

```python
# 用法：python extract-asar.py <app.asar 路径> <包名> [输出目录]
#   例：python extract-asar.py "C:\...\resources\app.asar" dsh-tools
import json, os, struct, sys

asar, pkg = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else 'dshdocs'

with open(asar, 'rb') as f:
    # asar 头固定 16 字节：4 个 uint32，第 4 个是头 JSON 的字节长度（随版本变化，故读而不写死）
    _, _, _, json_length = struct.unpack('<4I', f.read(16))
    manifest = json.loads(f.read(json_length).decode('utf-8'))
base = 16 + json_length

root = manifest['files']['dsh']['files']['node_modules']['files']['@deepseek-ai']['files']

def walk(node, prefix, entries):
    for name, val in node.get('files', {}).items():
        path = f'{prefix}/{name}' if prefix else name
        if 'files' in val:
            walk(val, path, entries)
        else:
            entries.append((path, val))

entries = []
walk(root[pkg], '', entries)
os.makedirs(out, exist_ok=True)
with open(asar, 'rb') as f:
    for rel, val in entries:
        if not rel.endswith(('.md', '.json')):
            continue
        f.seek(int(val['offset']) + base)
        with open(os.path.join(out, f'{pkg}__{rel.replace("/", "_")}'), 'wb') as g:
            g.write(f.read(val['size']))
print(f'{len(entries)} entries -> {out}')
```

说明：上面这段已在 macOS 上跑通（提取 `dsh-system-prompt` 的 5 个文件）。若仍失败，最省事的替代是把 `resources/app.asar` 用 7-Zip 打开（7-Zip 原生支持 asar），直接浏览 `dsh/node_modules/@deepseek-ai/*/README.zh.md`。
