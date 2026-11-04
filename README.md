# dsn-plugins

> DeepSeek Harness 插件集合 —— 让鲸鱼娘**记得住**，也**聊得来**。

一个 pnpm workspace monorepo，目前包含两个插件：

| 插件 | 一句话 | 状态 |
|---|---|---|
| [dsn-mnemo](packages/dsn-mnemo) | 跨会话记忆：原文 / 日记 / 锚点 | `0.7.2`（已发布 npm） |
| [dsn-whale-chat](packages/dsn-whale-chat) | 鲸鱼娘 QQ 聊天：通道 + 双人格 + 频率控制 | `0.1.8`（已发布 npm） |

两个插件解耦：聊天插件负责把 QQ 消息送进 DSH 并带上身份，记忆插件负责记住，互不依赖。

---

## dsn-mnemo · 记忆运行时

**让「想起」发生在正确的时机，以正确的形态。**

| 特性 | 说明 |
|---|---|
| **三层记忆** | L0 原文（聊天日志）→ L1 日记（主模型书写）→ L2 锚点（日期提醒） |
| **不调用模型** | 纯本地存储 + 检索 + 提示，零 LLM 成本；日记由正在对话的主模型自己写 |
| **主体隔离** | 私聊 `user:<id>`、群聊 `group:<id>`，跨主体默认隔离 |
| **中文检索** | `Intl.Segmenter` 预分词 + FTS5 + 字符兜底，长句也能召回 |
| **三级可见性** | `public` / `private` / `secret`，群聊里 `secret` 硬过滤 |
| **零第三方运行时依赖** | `node:sqlite` 单文件数据库，无原生模块 |

详见 [packages/dsn-mnemo](packages/dsn-mnemo)。

---

## dsn-whale-chat · 鲸鱼娘 QQ 聊天插件

**把 QQ 接进 DSH，还带上性格。**

| 特性 | 说明 |
|---|---|
| **OneBot 11 通道** | 连 NapCat / SnowLuma，指数退避重连、`message_id` 去重 |
| **双人格** | 小鲸鱼（萝莉）/ 大鲸鱼（御姐），配置可追加自定义人格 |
| **隐藏人格** | 恶趣味 / 贴吧喷子 / 女王，各有开关；**关闭时完全不注入** |
| **聊天控制** | @ / 全体 / 关键词触发；去抖合并、冷却、每分钟·每小时上限 |
| **认主** | 首条私聊自动认主（记 QQ 号，稳定）；只有主人能改人设 / 开关；群聊带说话人标签 |
| **闲时主动 + 随机插话** | **默认开启**；主动发言 15~30 分钟随机，插话每 10 分钟最多 3 次；支持免打扰时段 |
| **记忆交给 dsn-mnemo** | 本插件不内置记忆，只负责「把 QQ 消息变成 DSH 会话」 |

> ⚠️ **风险项（默认开启，可关）**：`闲时主动发言` 与 `随机插话` 默认打开，可能造成刷屏、打扰群友或触发平台风控。
> 如要规避风险，在 profile 配置里关闭：
>
> ```yaml
> proactive:
>   private: { enabled: false }
>   group: { enabled: false }
> randomInterject:
>   enabled: false
> ```

详见 [packages/dsn-whale-chat](packages/dsn-whale-chat)，人格卡在 [docs/persona](packages/dsn-whale-chat/docs/persona)。

---

## 快速开始

```sh
pnpm install        # 安装 workspace 依赖
pnpm -r build       # 构建全部包
pnpm -r test        # 跑全部单测
```

单包操作：

```sh
pnpm --filter dsn-mnemo run build
pnpm --filter dsn-whale-chat run build
```

---

## 免责声明

本项目是**非官方**的社区项目，与 DeepSeek 官方没有任何隶属关系。

- **QQ 接入有风险**：`dsn-whale-chat` 通过 OneBot（NapCat / SnowLuma 等）接入 QQ，属于非官方协议，**存在账号被风控、封禁的可能**。请使用小号、控制频率、自行承担风险。
- **主动发言 / 插话默认开启**：可能刷屏、打扰群友或放大风控风险；如要规避，在配置中关闭（见上文「风险项」）。
- **数据本地存储**：记忆与配置保存在本机（`~/.dsh/...`），不会上传；但请自行做好备份与隐私管理。
- **按「现状」提供**：不提供任何形式的明示或默示担保，使用后果自负。
- **内容责任**：隐藏人格（恶趣味 / 女王 / 贴吧喷子）可能产生不适宜内容，默认关闭；开启即表示你自行负责。

---

## 开源协议

本项目采用 [Apache License 2.0](LICENSE) 开源。

```
Copyright 2026 dsn-plugins contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## 文档

- `packages/dsn-mnemo/docs/`：记忆模型、多用户适配
- `packages/dsn-whale-chat/docs/`：聊天插件设计、人格卡（`persona/`）、QQ 接入
