# dsn-whale-chat

鲸鱼娘 QQ 聊天插件（DeepSeek Harness）：**OneBot 11 通道 + 人物背景 + 消息队列**。

记忆交给 [`dsn-mnemo`](https://www.npmjs.com/package/dsn-mnemo)，本插件不内置记忆，只负责「把 QQ 消息变成 DSH 会话」。

**交流群**：QQ 群 `1109648974`

## 特性

- **OneBot 11 通道**：连接 NapCat / SnowLuma，指数退避重连、`message_id` 去重。
- **单一人格**：小鲸鱼（萝莉），配置可追加自定义人格。
- **三个隐藏人格**：暴躁鲸鱼 / 贴吧喷子 / 小黄鱼，各有开关；**关闭时完全不注入**。
- **触发控制**：私聊全收；群聊支持 `@` / 全体 / 关键词。
- **频率控制**：去抖合并、冷却、每分钟·每小时上限。
- **闲时主动（仅私聊）+ 随机插话**：私聊主动 20~200 分钟随机、默认开；群聊主动默认关；插话默认开（每 10 分钟最多 1 次）。
- **余额查询**：装了 `dsh-balance-view` 后，`get_balance` 工具可查账户余额。
- **稳定前缀注入**：人格放在 `systemPrompt.section`，命中 prefix cache。

> ⚠️ **风险项**：私聊主动发言与群聊插话默认打开，可能打扰对方或放大平台风控；群聊闲时主动默认关。如要规避，在 profile 配置中关闭：
>
> ```yaml
> proactive:
>   private: { enabled: false }
>   group: { enabled: false }
> randomInterject:
>   enabled: false
> ```

## 安装

```sh
dsh plugin install dsn-whale-chat
```

或写进 profile 的 `bundles`。

## 最小配置

```yaml
wsUrl: ws://127.0.0.1:3001
accessToken: ''
persona:
  active: little-whale
  addressUser: 哥哥
toggles:
  mischief: false
  queen: false
  kaomoji: false
  troll: false
trigger:
  group: at
```

完整配置（触发、频率、闲时主动、随机插话、免打扰、自定义人格）见仓库 `docs/chat-plugin.md`。

## 许可

[Apache License 2.0](LICENSE)。
