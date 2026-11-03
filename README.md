# dsn-mnemo

> 鲸鱼娘的**记忆运行时**。让「想起」发生在正确的时机，以正确的形态。

`dsn-mnemo` 是一个 DeepSeek Harness（DSH）插件。它**不负责人设，也不实现任何聊天协议**——人设由 persona 插件或 preset 提供，QQ/Discord 等通道由各自的通道插件提供；它只做一件事：记录发生过什么、把值得留下的沉淀成记忆、在合适的时候把对的事浮现进当前对话。

## 它要解决什么

一次对话结束后，上下文就被丢弃了：模型不记得昨天聊过什么，也不会在特殊的日子主动提起什么——除非有人把记忆重新端到它面前。

`dsn-mnemo` 就是这个「端记忆」的基础设施：

- **留下痕迹**：聊天内容落盘（人类消息 + 助手可见回复），不必依赖窗口内的对话历史；
- **主动沉淀**：对话沉落之后，判断这段交流里有没有值得留给「下一个自己」的事；
- **恰当地想起**：有线索时按需深掘，有话题时按**关联**浮现，到日子时被锚点唤起——全部按需，不设固定预算。

## 特性

- **三层记忆**：L0 原文 → L1 日记 → L2 锚点，职责分离；
- **日记由主模型书写**：像人写日记一样，日常流水账也记、无条数上限；闲时或超长后在下一消息提示补写；
- **按需、关联**：从最近话题段构造查询，检索日记，过阈值才注入，同一条记忆 10 轮内不重复；
- **主体化**：私聊记忆归 `user:<id>`，群聊记忆归 `group:<id>`；跨主体默认隔离，群聊不串私聊内容；
- **三级可见性**：`public` / `private` / `secret`；群聊里 `secret` 硬过滤，`private` 只允许暗示；
- **通道无关**：只消费 DSH 的 `session/event` 与消息 `source` 里的身份字段，不绑定任何协议；
- **缓存友好**：稳定前缀字节稳定，动态记忆只走 `context()` 与工具返回；
- **中文检索**：预分词 + FTS5，并用字符级兜底覆盖分词错位的说法；
- **零第三方运行时依赖**：`node:sqlite` 单文件数据库，无原生模块、无外部向量库。

## 三层记忆

| 层级 | 内容 | 保留 | 检索方式 |
|---|---|---|---|
| **L0** 原文 | 人类消息 + 助手可见回复（不含思考、工具调用与注入上下文） | 长期 | 词面检索，按主体过滤 |
| **L1** 日记 | 第一人称、长度不限，带重要度/情绪/可见性 | 长期 | BM25 + 重要度 + 近因 |
| **L2** 锚点 | 纪念日、约定、截止日期，可重复 | 长期 | 日期窗口匹配，注入主体上下文 |

记忆挂在 `(subject_kind, subject_id)` 上：本地桌面是 `user:local`，通道私聊是 `user:<userId>`，群聊是 `group:<groupId>`。通道只要把稳定身份（用户 id、群 id、是否在叫助手）放进消息 `source` 即可，去重、接话、限流都属于通道。

## 使用示例

**1. 日常聊天——什么都不用做**

装好之后正常对话即可。L0 原文自动落盘；闲时或超长后，下一条消息会提示补写日记。下次新开会话，相关的记忆会被自动带进上下文。

**2. 模型主动深掘**

> 用户：我们上次聊到哪了？
>
> 模型调用 `recall({ query: "上次 聊到哪", scope: "log" })` → 取回之前的对话原文，再回答。

日记层用 `scope: "diary"`：`recall({ query: "发布 npm", scope: "diary" })` 会按 BM25 + 重要度 + 近因排序返回蒸馏后的记忆。

**3. 记下一个约定**

> 用户：下周三陪我去看海，别忘了。
>
> 模型调用 `anchor_upsert({ event_name: "一起看海", target_date: "2026-11-11", window_days: 1 })`。

到那天，锚点会出现在系统提示的稳定前缀里，由模型自然地提起；日期过了、既没提醒也没处理，才算「错过」。

**4. 纠正一条记忆**

> 用户：记错了，是周四不是周三。
>
> 模型调用 `diary_update({ id: 12, content: "……", reason: "用户纠正日期" })`——必须给理由，旧正文自动进 `diary_revisions`。

**5. 清空某个人或某个群**

`mnemo_forget({ subject_kind: "user", subject_id: "<QQ号>" })`，聊天记录、日记、锚点、画像一并清除。

## 内置工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `recall` | `query`、`scope: diary \| log`、`limit?` | 深掘记忆：日记走 BM25+重要度+近因，日志走词面检索 |
| `diary_write` | `content`、`importance?`、`emotion?`、`tags?` | 把值得记住的内容写进日记（主模型自行调用，无条数上限） |
| `diary_update` | `id`、`content`、`reason` | 纠正日记；必须给理由，旧正文进 `diary_revisions` |
| `anchor_upsert` | `event_name`、`target_date`、`window_days?`、`tone_hint?`、`repeat?` | 录入锚点（`YYYY-MM-DD`，可声明 daily/weekly/monthly/yearly） |
| `mnemo_forget` | `subject_kind: user \| group`、`subject_id` | 清空某个人/某个群的全部记忆 |
| `mnemo_ping` | — | 健康检查：返回版本与数据库路径 |

## 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `dbPath` | `~/.dsh/mnemo/mnemo.db` | SQLite 单文件路径（支持 `~`） |
| `diaryIdleMinutes` | `20` | 距上次回复多久后，在下一条消息提示补写日记；范围 5–1440 分钟 |
| `diaryMaxTurns` | `30` | 距上次提示超过多少轮后，主动提示补写日记；范围 10–500 |
| `diaryMaxChars` | `12000` | 距上次提示超过多少字符后，主动提示补写日记 |
| `storeReasoning` | `false` | 是否把思考过程写进 `raw`；默认丢弃，且从不参与检索 |
| `anchorWindowDays` | `2` | 锚点前后各几天可触发（单条锚点可覆盖） |
| `contextRecallLimit` | `20` | 前置浮现最多条数（关联排序，可为 0） |
| `contextRecallTokens` | `600` | 前置浮现的 token 预算上限 |
| `recallDiaryLimit` | `5` | `recall` 日记召回条数 |
| `recallLogLimit` | `5` | `recall` 日志召回条数 |

## 安装

**从插件市场**：插件 → 发现 → 添加索引源 → 粘贴索引 URL → 搜索 `dsn-mnemo` → 安装，重启一次 DSH 即生效；数据库会在首次启动时自动创建。

**从源码（开发期）**：

```powershell
# 用 DSH 自带的 Node（24.x）
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

& $node $pnpm install
& $node $pnpm run build
```

然后把插件加进 profile 的 patch（`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，**改前备份**）：

```yaml
- insert:
    - id: dsn-mnemo
      name: "file:///C:/Users/<你>/Documents/GitHub/dsn-mnemo/lib/index.js"
      config:
        dbPath: "C:/Users/<你>/.dsh/mnemo/mnemo.db"
```

保存后 HMR 约 2 秒重新组合；首次接入或改插件代码后建议重启一次 DSH。

## 隐私

记忆是**纯本地明文** SQLite：`dbPath` 可配置，默认在 `~/.dsh` 下；不要把它放到 OneDrive 之类的同步目录。删除数据库文件即清空全部记忆，也可以用 `mnemo_forget` 按主体清理。群聊场景下 `secret` 永不进入群上下文，`private` 只允许暗示。

## 文档

- [DESIGN.md](DESIGN.md) — 原始设计文档与「实现修正」。
- [PLAN.md](PLAN.md) — 开发计划与阶段进度（也含构建、测试与真机验证方法）。
- [docs/memory-model.md](docs/memory-model.md) — 记忆系统规范：三层、两种主体、读写路径、锚点与关联检索。
- [docs/multi-user.md](docs/multi-user.md) — 多用户环境的记忆模型（身份 / 私聊记忆 / 群记忆）。
- [docs/qq-integration.md](docs/qq-integration.md) — 通道接入分析（QQ 为例）；通道本身不属于本仓库。

## 许可

[Apache License 2.0](LICENSE)
