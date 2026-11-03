# dsn-mnemo

> 鲸鱼娘的**记忆运行时**。让「想起」发生在正确的时机，以正确的形态。

`dsn-mnemo` 是一个 DeepSeek Harness（DSH）插件。它**不负责人设，也不实现任何聊天协议**——人设由独立的 persona 插件或 preset 提供，QQ/Discord 等通道由各自的通道插件提供；它只做一件事：记录发生过什么、把值得留下的沉淀成记忆、在合适的时候把对的事浮现进当前对话。

---

## 它要解决什么

一次对话结束后，上下文就被丢弃了。模型既不记得昨天聊过的话题，也不会在今天这个特殊的日子里主动提起什么——除非有人把记忆重新端到它面前。

`dsn-mnemo` 就是这个「端记忆」的基础设施：

- **留下痕迹**：聊天内容落盘（人类消息 + 助手可见回复），不必依赖窗口内的对话历史；思考过程、工具调用与工具结果不入库；
- **主动沉淀**：在对话真正沉落之后（默认 20 分钟无活动），判断这段交流是否值得写给「下一个自己」；
- **恰当地想起**：有线索时按需深掘，有时间/情绪线索时按**关联**浮现，有纪念日时被锚点唤起——全部按需，不设固定 token 预算。

## 核心特性

- **四层记忆**：L0 聊天日志 → L1 日记 → L2 记忆点 → L3 锚点，职责与生命周期分离；
- **短效 + 长效**：L2 记忆点保留 7 天，重复出现或足够重要时晋升为 L1 日记；L1/L3 长期保留；
- **按需、关联**：前置浮现用当前这句话做关联检索（词面 + 实体 + 时间模式），只有过阈值的才注入；上限 20 条 / 600 token，**可以为 0 条**；
- **主体化**：私聊记忆归 `user:<id>`，群聊记忆归 `group:<id>`；跨主体默认隔离，群聊不串私聊内容；
- **三级可见性**：`public` / `private` / `secret`；群聊里 `secret` 硬过滤，`private` 只允许暗示；
- **通道无关**：只消费 DSH 的 `session/event` 与消息 `source` 里的身份字段，不绑定 QQ 或任何协议；
- **三种日记触发**：重要事件立即写、内容过长主动写、空闲 20 分钟写；一次极短判断调用，宁缺毋滥；
- **缓存友好**：稳定前缀字节稳定，动态记忆只走 `context()` 与工具返回；
- **中文检索**：`Intl.Segmenter` 预分词 + FTS5，再用字符级兜底覆盖「看海 / 看了海」这类分词错位；
- **零第三方运行时依赖**：`node:sqlite` 单文件数据库，无原生模块、无外部向量库；
- **严格的日记修改**：`diary_update` 必须给理由，改前自动写 `diary_revisions`；
- **与人设解耦**：只接收可选的 `diaryPersonaHint`，不内置任何角色 prompt。

## 记忆主体

所有记忆挂在 `(subject_kind, subject_id)` 上：

| 场景 | 主体 | 来源 |
|---|---|---|
| 本地桌面私聊 | `user:local` | `source.kind === 'user'` |
| 通道私聊 | `user:<userId>` | `source.kind === 'qq'`（或任意自定义 kind）且只有 `userId` |
| 群聊 | `group:<groupId>` | `source.kind === 'qq'` 且带 `groupId` |

通道要做的事只有一件：把稳定身份（用户 id、群 id、是否在叫助手）放进消息 `source`，并产生正常的 session 事件。通道可以是一个独立插件、外部桥或别的实现；协议适配、去重、接话策略、限流都属于通道，不属于本插件。

## 四层记忆

| 层级 | 内容 | 存储 | 检索方式 |
|---|---|---|---|
| **L0** 聊天日志 | 人类消息 + 助手可见回复（不含思考、工具调用、工具结果与注入上下文） | `messages` + `messages_fts`（FTS5） | 词面检索，按主体过滤 |
| **L1** 日记 | 第一人称、2–3 句、带重要度/情绪/可见性 | `diaries` + `diaries_fts`（FTS5） | BM25 + 重要度 + 近因 |
| **L2** 记忆点 | 一句话的小事/话题/人物/待办，7 天过期 | `memory_points` + `memory_points_fts`（FTS5） | 关联检索；重复/重要 → 晋升 L1 |
| **L3** 锚点 | 纪念日、约定、截止日期，可重复 | `anchors` | 日期窗口匹配，注入主体上下文 |

L0 刻意**不建向量索引**：词面检索更接近「需要想起准确的词才能找到」的真实体验。L2 是短效层，过期即清理；L1/L3 不做自动过期。

## 三种回忆行为

1. **前置浮现**：用户消息含时间指代（「上次」「你还记得吗」）或情绪词时，用这句话关联检索 L2 记忆点与 L1 日记，渲染进该 agent 的 `systemPrompt.context()`。上一轮的浮现内容会被新快照取代，不会累积。
2. **按需深掘**：模型调用 `recall`。`scope=diary` 搜日记（BM25 + 重要度 + 近因），`scope=log` 搜聊天记录（需要更精确的线索）；两者都按当前主体过滤，群聊里 `secret` 永不返回。
3. **锚点触发**：按日期窗口检查当前主体的锚点，命中就写进上下文；支持 daily/weekly/monthly/yearly 重复。日期过了、既没提醒过也没处理过，才算「错过」。

## 可见性

| 级别 | 写入场景 | 群聊里 |
|---|---|---|
| `public` | 群里说过的 | 可正常引用 |
| `private` | 私聊说过的 | 只允许暗示，不复述细节 |
| `secret` | 判断模型标记的秘密 | 硬过滤，永不出现 |

一对一里所有级别都可用；可见性只在「群聊要用到私聊内容」时才产生行为差异。

## 架构一览

```
DSH 对话循环
   │
   ├─ systemPrompt.section('mnemo:rules')   ← 稳定前缀：记忆规则 + 本地锚点
   ├─ systemPrompt.context('mnemo:recall')  ← 动态快照：关联浮现结果（每轮替换）
   ├─ systemPrompt.context('mnemo:anchors') ← 群聊主体自己的锚点（每轮替换）
   ├─ tools                                 ← recall / diary_* / anchor_upsert / mnemo_forget / mnemo_ping
   └─ session/event                         ← L0 落地；turn/end → 三种日记触发
                                                     │
                                               SQLite：L0 / L1 / L2 / L3
                                               FTS5（Intl.Segmenter 预分词）
```

关键约束：**稳定前缀的字节不随每轮检索结果变化**，否则前缀缓存失效。这也是把「浮现结果」放进 `context()` 而不是 `section()` 的原因。

## 安装（开发期）

```powershell
# 用 DSH 自带的 Node（24.x）
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

& $node $pnpm install
& $node $pnpm run build
```

把插件加进 profile 的 patch（`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，**改前备份**）：

```yaml
- insert:
    - id: dsn-mnemo
      name: "file:///C:/Users/you/Documents/GitHub/dsn-mnemo/lib/index.js"
      config:
        dbPath: "C:/Users/you/.dsh/mnemo/mnemo.db"
```

保存后 HMR 约 2 秒重新组合；首次接入或改插件代码后建议重启一次 DSH。

## 内置工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `recall` | `query`、`scope: diary \| log`、`limit?` | 深掘记忆：日记走 BM25+重要度+近因，日志走词面检索 |
| `diary_write` | `content`、`importance?`、`emotion?`、`tags?` | 手动写一篇日记（后台引擎也会自动写） |
| `diary_update` | `id`、`content`、`reason` | 纠正日记；必须给理由，旧正文进 `diary_revisions` |
| `diary_consolidate` | — | 立即对当前会话跑一次日记判断（不等空闲计时） |
| `anchor_upsert` | `event_name`、`target_date`、`window_days?`、`tone_hint?`、`repeat?` | 录入锚点（`YYYY-MM-DD`，可声明 daily/weekly/monthly/yearly） |
| `mnemo_forget` | `subject_kind: user \| group`、`subject_id` | 清空某个人/某个群的全部记忆（消息、日记、记忆点、锚点、person） |
| `mnemo_ping` | — | 健康检查：返回版本与数据库路径 |

## 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `dbPath` | `~/.dsh/mnemo/mnemo.db` | SQLite 单文件路径（支持 `~`） |
| `diaryIdleMinutes` | `20` | 空闲多久后触发日记判断；范围 5–1440 分钟 |
| `diaryMaxTurns` | `30` | 距上次判断的对话超过多少轮后主动写日记；范围 10–500 |
| `diaryMaxChars` | `12000` | 距上次判断的对话超过多少字符后主动写日记；范围 2000–200000 |
| `diaryImmediateOnImportant` | `true` | 出现「生日/约定/离别」等重要信号时立即判断，不等空闲 |
| `diaryMaxPerSession` | `3` | 每个主体最多保留的日记数 |
| `diaryProvider` | `deepseek-account` | 判断调用使用的 provider route |
| `diaryModel` | `deepseek-flash` | 判断调用使用的模型 |
| `diaryPersonaHint` | `""` | 可选的日记口吻提示 |
| `storeReasoning` | `false` | 是否把模型的思考过程写进 `raw` JSON；默认丢弃，且从不参与检索 |
| `anchorWindowDays` | `2` | 锚点前后各几天可触发（单条锚点可覆盖） |
| `contextRecallLimit` | `20` | 前置浮现最多条数（关联排序，可为 0） |
| `contextRecallTokens` | `600` | 前置浮现的 token 预算上限 |
| `recallDiaryLimit` | `5` | `recall` 日记召回条数 |
| `recallLogLimit` | `5` | `recall` 日志召回条数 |

## 开发

```powershell
& $node $pnpm run build     # tsc → lib/
& $node $pnpm test          # node --test
& $node scripts\harness-test.mjs   # 真实 Service + Session + 事件链路的集成验证
& $node scripts\mnemo-status.mjs   # 查看记忆库里现有数据
```

单测依赖 `node:sqlite`，请用 DSH 自带 Node 24（系统 Node 22 早期版本需要 `--experimental-sqlite`）。

## 打包与发布到 DSH 插件市场

DSH 的「插件市场」不是上传中心，而是**索引驱动**的：DSH 自身不预置任何索引源，用户要在「插件 → 发现 → 添加索引源」里填一个索引 URL，市场再按索引安装。

完整步骤（推送、npm 发布、索引托管、版本升级）见 [docs/publishing.md](docs/publishing.md)。仓库里已经生成好一份 [market-index.json](market-index.json)，托管后把它的 HTTPS 地址给用户即可。

这条链路要求三样东西，本仓库都已就绪：

1. **可发布的包**：`package.json` 已声明
   ```json
   "engines": { "node": ">=24", "dsh": "^0.2.1-rc.5" },
   "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }
   ```
   `cordis.patch.yml` 是组合包（bundle）层，安装后自动把 `dsn-mnemo` 这一行插入 profile。`prepack` 会先跑 `tsc`，保证发布的 `lib/` 是最新的。
2. **发布到 npm（或 Git）**：
   ```powershell
   # 发布脚本里的 tsc 需要 node 在 PATH 上；用 DSH 自带 Node 时先加进 PATH
   $env:PATH = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
   & $node $pnpm publish --access public
   ```
   也可以只推 Git 仓库，市场索引里用 `{"type":"git","url":...,"commit":...}` 指向固定提交。
3. **市场索引 JSON（格式 1）**：见 [docs/market-index.example.json](docs/market-index.example.json)，一个最小可用样例。字段要点：
   - 顶层 `format: 1`、`title`（至少含 `en`）、`plugins[]`；
   - 每个插件 `name`（npm 包名）+ `versions[]`，每个版本 `version`、`publishTimestamp`（Unix 秒）、`source`（`npm` 或 `git`）、可选 `engines.dsh`；
   - 可选 `metadata.categories/labels/sortKeys` 与插件的 `metadata.category/keywords/labels/sortKeys`。

   把这份 JSON 放到任意 HTTPS 地址，用 DSH 自带的校验器先验一遍：
   ```powershell
   & $node $pnpm run market:check
   ```
   （等价于调用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex`，与 DSH 安装时用的是同一套规则。）

之后用户侧的步骤：**插件 → 发现 → 添加索引源** → 粘贴索引 URL → 搜索 `dsn-mnemo` → 安装。安装由 `pluginManager.installBundle` 用 `pnpm add dsn-mnemo@<version>` 完成，profile 的 `dsh.profile.bundles` 会追加该组合包。

> 注意：`package.json` 必须是**无 BOM 的 UTF-8**。带 BOM 时 DSH 读取包清单会失败并把插件行静默禁用（本环境踩过：桌面端表现为插件完全不加载，只在启动日志里出现一行 JSON 解析错误）。PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，改完 `package.json` 请用 Node 或支持无 BOM 的编辑器保存。

## 隐私

记忆是**纯本地明文** SQLite：`dbPath` 可配置，默认在 `~/.dsh` 下；不要把它放到 OneDrive 之类的同步目录。删除数据库文件即清空全部记忆；也可以用 `mnemo_forget` 按主体清理。群聊场景下 `secret` 永不进入群上下文，`private` 只允许暗示。

## 文档

- [PLAN.md](PLAN.md) — 开发计划与交接：环境实测、架构定稿、阶段进度、PC 端验证手册。
- [DESIGN.md](DESIGN.md) — 原始设计文档；实现与设计不一致处见文末「实现修正」。
- [docs/publishing.md](docs/publishing.md) — 发布纪律（先测后发、先问再发）与市场索引托管步骤。
- [docs/memory-model.md](docs/memory-model.md) — **记忆系统规范**：四层、两种主体、读写路径、锚点与关联检索。
- [docs/multi-user.md](docs/multi-user.md) — 多用户环境的记忆模型（身份 / 私聊记忆 / 群记忆）。
- [docs/qq-integration.md](docs/qq-integration.md) — 通道接入分析（QQ 为例）；通道本身不属于本仓库。

## 许可

[Apache License 2.0](LICENSE)
