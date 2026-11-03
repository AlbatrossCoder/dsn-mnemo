# dsn-mnemo

> 鲸鱼娘的**记忆运行时**。让「想起」发生在正确的时机，以正确的形态。

`dsn-mnemo` 是一个 DeepSeek Harness（DSH）插件。它**不负责人设**——人设由独立的 persona 插件或 preset 提供；它只做一件事：记录发生过什么、把值得留下的沉淀成日记、在合适的时候把对的事浮现进当前对话。

**当前状态**：`0.5.0`，P0–P5 已实现，单测 74/74、集成 harness 全绿。桌面端需重启一次以加载插件；真机验收清单见 [PLAN.md](PLAN.md) §5 与 §7.4。

---

## 它要解决什么

一次对话结束后，上下文就被丢弃了。模型既不记得昨天聊过的话题，也不会在今天这个特殊的日子里主动提起什么——除非有人把记忆重新端到它面前。

`dsn-mnemo` 就是这个「端记忆」的基础设施：

- **留下痕迹**：完整消息落盘，不必依赖窗口内的对话历史；
- **主动沉淀**：在对话真正沉落之后（默认 30 分钟无活动），判断这段交流是否值得写给「下一个自己」；
- **恰当地想起**：有线索时按需深掘，有时间/情绪线索时自动浮现，有纪念日时被锚点唤起。

## 核心特性

- **四层记忆**：L0 全量日志 → L1 日记 → L2 工作层 → L3 锚点，职责与存储策略分离；
- **三种回忆行为**：前置浮现（按 agent 的运行时上下文）、按需深掘（`recall` 工具）、锚点触发（日期窗口注入稳定前缀）；
- **缓存友好**：稳定前缀（规则 + 当天锚点）字节稳定，动态记忆只走 `context()` 与工具返回；
- **中文检索**：`Intl.Segmenter` 预分词 + FTS5，再用字符级兜底覆盖「看海 / 看了海」这类分词错位；
- **零第三方运行时依赖**：`node:sqlite` 单文件数据库，无原生模块、无外部向量库；
- **克制的日记写入**：空闲触发 + 一次极短判断调用 + 每会话上限，宁缺毋滥；
- **严格的日记修改**：`diary_update` 必须给理由，改前自动写 `diary_revisions`；
- **与人设解耦**：只接收可选的 `diaryPersonaHint`，不内置任何角色 prompt。

## 四层记忆

| 层级 | 内容 | 存储 | 检索方式 |
|---|---|---|---|
| **L0** 全量日志 | 每条 user / assistant / tool 消息 | `messages` + `messages_fts`（FTS5） | 词面检索，需精确线索 |
| **L1** 日记 | 第一人称、2–3 句、带重要度与情绪标签 | `diaries` + `diaries_fts`（FTS5） | BM25 + 重要度 + 近因 |
| **L2** 工作层 | 会话元状态、关系阶段、最近消息 | `sessions` / `work_state` | 直接读取 |
| **L3** 锚点 | 纪念日等「到点就该被提起」的事 | `anchors` | 日期窗口匹配，注入稳定前缀 |

L0 刻意**不建向量索引**：词面检索更接近「需要想起准确的词才能找到」的真实体验。

## 三种回忆行为

1. **前置浮现**：用户消息含时间指代（「上次」「你还记得吗」）或情绪词时，检索日记 top N，渲染进该 agent 的 `systemPrompt.context()`。上一轮的浮现内容会被新快照取代，不会累积。
2. **按需深掘**：模型调用 `recall`。`scope=diary` 搜日记（BM25 + 重要度 + 近因），`scope=log` 搜原始对话（需要更精确的线索）。
3. **锚点触发**：跨日时按日期窗口检查锚点，命中就写进稳定前缀；同一天内字节不变。

## 架构一览

```
DSH 对话循环
   │
   ├─ systemPrompt.section('mnemo:rules')   ← 稳定前缀：记忆规则 + 当天命中的锚点
   ├─ systemPrompt.context('mnemo:recall')  ← 动态快照：前置浮现结果（每轮替换）
   ├─ tools                                 ← recall / diary_write / diary_update / anchor_upsert
   └─ session/event                         ← L0 落地；turn/end → 关系阶段 + 30 分钟空闲计时
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
| `anchor_upsert` | `event_name`、`target_date`、`window_days?`、`tone_hint?` | 录入锚点（`YYYY-MM-DD`，会校验真实日历日） |
| `mnemo_ping` | — | 健康检查：返回版本与数据库路径 |

## 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `dbPath` | `~/.dsh/mnemo/mnemo.db` | SQLite 单文件路径（支持 `~`） |
| `diaryIdleMinutes` | `30` | 空闲多久后触发日记判断 |
| `diaryMaxPerSession` | `3` | 每会话日记上限 |
| `diaryProvider` | `deepseek-account` | 判断调用使用的 provider route |
| `diaryModel` | `deepseek-flash` | 判断调用使用的模型 |
| `diaryPersonaHint` | `""` | 可选的日记口吻提示 |
| `anchorWindowDays` | `2` | 锚点前后各几天可触发（单条锚点可覆盖） |
| `contextRecallLimit` | `3` | 前置浮现最多条数 |
| `recallDiaryLimit` | `5` | `recall` 日记召回条数 |
| `recallLogLimit` | `5` | `recall` 日志召回条数 |

## 关系阶段

不设硬性轮数阈值，由沉淀量驱动，每次 `turn/end` 后更新一次，不调用模型：

```
score = sessions_count + diary_count × 0.5
score < 5   → initial
score < 20  → familiar
score ≥ 20  → close
```

## 开发

```powershell
& $node $pnpm run build     # tsc → lib/
& $node $pnpm test          # node --test，74 项
& $node scripts\harness-test.mjs   # 真实 Service + Session + 事件链路的集成验证
& $node scripts\mnemo-status.mjs   # 查看记忆库里现有数据
```

单测依赖 `node:sqlite`，请用 DSH 自带 Node 24（系统 Node 22 早期版本需要 `--experimental-sqlite`）。

## 隐私

记忆是**纯本地明文** SQLite：`dbPath` 可配置，默认在 `~/.dsh` 下；不要把它放到 OneDrive 之类的同步目录。删除数据库文件即清空全部记忆。

## 文档

- [PLAN.md](PLAN.md) — 开发计划与交接：环境实测、架构定稿、阶段进度、PC 端验证手册。
- [DESIGN.md](DESIGN.md) — 原始设计文档；实现与设计不一致处见文末「实现修正」。

## 许可

[Apache License 2.0](LICENSE)
