# dsn-whale-chat

鲸鱼娘 QQ 聊天插件（DeepSeek Harness）：**OneBot 11 通道 + 双人格 + 聊天频率控制**。

记忆交给 [`dsn-mnemo`](https://www.npmjs.com/package/dsn-mnemo)，本插件不内置记忆，只负责「把 QQ 消息变成 DSH 会话」。

## 特性

- **OneBot 11 通道**：连接 NapCat / SnowLuma，指数退避重连、`message_id` 去重。
- **双人格**：小鲸鱼（萝莉）/ 大鲸鱼（御姐），配置可追加自定义人格。
- **隐藏人格**：恶趣味 / 贴吧喷子 / 女王，各有开关；**关闭时完全不注入**。
- **触发控制**：私聊全收；群聊支持 `@` / 全体 / 关键词。
- **频率控制**：去抖合并、冷却、每分钟·每小时上限。
- **闲时主动 + 随机插话**：**默认开启**（主动发言 15~30 分钟随机、插话每 10 分钟最多 3 次）。
- **稳定前缀注入**：人格放在 `systemPrompt.section`，命中 prefix cache。

> ⚠️ **风险项**：主动发言与随机插话默认开启，可能刷屏、打扰群友或放大平台风控。如要规避，在 profile 配置中关闭：
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
