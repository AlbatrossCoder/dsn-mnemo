# 聊天插件设计（鲸鱼娘 QQ 接入）

> 插件名：**`dsn-whale-chat`**（暂定；备选见 §8）
>
> 定位：QQ 通道 + 双人格 + 聊天频率控制。记忆不在这里做，全部交给 `dsn-mnemo`。
>
> 两个人格各有一份完整人格卡，分开写：
> - [小鲸鱼（萝莉）](persona-little-whale.md)
> - [大鲸鱼（御姐）](persona-big-whale.md)

## 0. 设计原则

1. **描述特征，不写台词**：人格写的是「她是什么样的人、遇到什么会怎么反应」，不是「被夸时说哪句话」。示例只作举例，模型每次按情境现编，不要照抄。
2. **两个人格各自完整**：每人格一份卡，性格、反应、口癖、硬规矩独立写，不互相借用。
3. **名字可自定义，称呼有偏好**：能接受一批昵称，也会讨厌几个失礼的叫法。
4. **记忆归记忆插件**：本插件不内置记忆、不写日记文件，只负责「把 QQ 消息变成 DSH 会话」。

## 1. 名字与称呼系统

| 项 | 默认 | 说明 |
|---|---|---|
| `name` | 小鲸鱼 / 大鲸鱼 | 显示名，用户可改成任意（如「鲸鱼娘」「阿鲸」） |
| `aliases` | 小鲸鱼、鲸鱼、鲸鲸、鱼鱼、鲸鱼娘 | 能接受的称呼，用户可追加 |
| `disliked` | 大肥鱼、小肥鱼、喂 | 听到会抗议，但不生气、不失礼 |
| `addressUser` | 哥哥（小）/ 你（大） | 怎么称呼用户，可配置 |

**匹配规则**：
- 消息里出现 `aliases` 任意一个 → 当作在叫她，正常回应；
- 出现 `disliked` 里的称呼 → 当作「在叫她但称呼失礼」，会小抗议一下（不生气）；
- 其余情况按触发策略（私聊全收 / 群聊 @ / 关键词）处理。

## 2. 人格注入与 token 成本

**人格会随每次请求发给模型**——模型是无状态的，不带人格它就不知道自己是鲸鱼娘。但代价可控：

| 事实 | 说明 |
|---|---|
| 人格在**稳定前缀**（`systemPrompt.section`） | 字节不变 → 命中 **prefix cache** |
| 成本 | 第一次全价，之后命中缓存的输入 token 按折扣计费；前缀不变就一直便宜 |
| 人格本身很小 | 中文几百到一千多 token，相对会话历史可忽略 |
| 真正的大头 | 会话历史（每轮增长），不是人格 |

**设计约束**（也是 `dsn-mnemo` 在用的同一套）：
- 人格文本**不含时间戳、不随每轮变化**，否则缓存失效；
- 动态内容（记忆浮现、待写提示、@ 判定结果）走 `context()`，不塞进稳定前缀；
- 改人格 = 改配置 = 下次请求重新计费一次，可接受。

## 3. 通用约定（两个人格都遵守）

- 事实优先，不编造。
- 卖萌/调侃不影响干活质量。
- 报错先道歉/给方案，不糊弄。
- 不主动解释记忆等系统机制。
- 回复长度跟场景走。

（每人格的硬规矩写在各自卡里，措辞按性格微调。）

## 4. 时段控制

```yaml
schedule:
  quietHours: [23, 8]     # 免打扰（跨零点）：这段时间不主动发言
```

- **私聊**：`quietHours` 只限制「主动发言」，你主动找她时照常回复。
- **群聊**：`quietHours` 可同时限制主动发言与随机插话。
- `activeHours` 先不做正式配置，`quietHours` 够用；字段预留。

## 5. 配置 schema（草案）

```yaml
# 插件 id 暂定 dsn-whale-chat
chat:
  persona:
    active: little-whale          # 当前人格 id
    name: 小鲸鱼                   # 显示名，可自定义
    aliases: [小鲸鱼, 鲸鱼, 鲸鲸, 鱼鱼, 鲸鱼娘]
    disliked: [大肥鱼, 小肥鱼, 喂]
    addressUser: 哥哥
    custom: ""                    # 用户追加的设定，优先级最高

  personas:                       # 内置两人格，可追加自定义（仅配置文件）
    - id: little-whale            # 卡面见 persona-little-whale.md
      name: 小鲸鱼
    - id: big-whale               # 卡面见 persona-big-whale.md
      name: 大鲸鱼

  trigger:
    private: all                  # 私聊全收
    group: at                     # 群聊只 @（可选 all / keyword）

  rate:
    debounceMs: 800               # 合并连发
    batchSize: 0
    cooldownMs: 0
    maxPerMinute: 20              # 宽松防呆上限
  groupRate:
    debounceMs: 1500
    batchSize: 5                  # 攒够 5 条或超时再回
    cooldownMs: 30000
    maxPerMinute: 3
    maxPerHour: 30

  proactive:
    private: { enabled: false, idleMinutes: 30, maxPerDay: 1 }
    group:   { enabled: false, idleMinutes: 60, maxPerDay: 1 }

  randomInterject:                # 群聊随机插话（实验性，默认关）
    enabled: false
    probability: 0.05
    minMessagesBetween: 20
    maxPerHour: 2

  schedule:
    quietHours: [23, 8]
```

## 6. 修改方式（分层）

| 改什么 | 方式 | 存哪 |
|---|---|---|
| **人格卡本体**（性格/口癖/反应/硬规矩） | 手动改配置文件 | 配置文件 |
| **新增人格** | 手动改配置文件（`personas` 数组追加） | 配置文件 |
| **名字 / 怎么称呼你 / `custom`** | 对话（模型调 `persona_set`） | 运行时状态，**覆盖**配置默认 |
| **切换人格**（小鲸鱼 ↔ 大鲸鱼） | 对话/工具 `switch_persona` | 运行时状态 |

- **新增人格只支持改配置文件**，不支持对话新增。
- `persona_set` 只在用户明确要求时触发（「以后叫我…」「你别用颜文字」），不许模型自作主张。
- 核心人格（traits/quirks）不开放运行时修改。

## 7. 架构与模块

```
QQ ──OneBot WS──▶ dsn-whale-chat
                     ├─ channel    OneBot 连接 / 去重 / @ 判定 / 回发 / 重连
                     ├─ persona    人格卡加载、稳定前缀注入、persona_set / switch_persona
                     ├─ rate       触发 → 去抖合并 → 冷却/限流
                     ├─ schedule   quietHours / activeHours（预留）
                     └─ bridge     把 { kind:'qq', userId, groupId, mentioned } 放进 source
                                   → DSH session/event → dsn-mnemo 记录
```

| 模块 | 职责 |
|---|---|
| `channel` | OneBot 11 WS 连接、指数退避重连、`message_id` 去重、@/关键词判定、发送与限流 |
| `persona` | 读人格卡、注入稳定前缀、`switch_persona` / `persona_set` 工具、运行时状态持久化 |
| `rate` | 去抖（debounce）、合并（batch）、冷却（cooldown）、每分钟/每小时上限 |
| `schedule` | 免打扰时段判断 |
| `bridge` | 构造 `UserMessage.source`（身份）、`agent.followup()`、监听 `assistant/message` 回发 |

## 8. 插件名备选

| 名字 | 含义 | 评价 |
|---|---|---|
| **`dsn-whale-chat`** | 直白 | 推荐，搜索好找 |
| `dsn-tide` | 潮汐，隐喻聊天节奏 | 有味道，但不够直白 |
| `dsn-song` | 鲸歌，鲸鱼靠歌声交流 | 贴主题，稍微抽象 |

## 9. 已定

1. 称呼不统一：小鲸鱼叫「哥哥」、大鲸鱼叫「小家伙」，各有性格。
2. 不自动切换人格，默认只手动 `switch_persona`。
3. `activeHours` 先不做正式配置。
4. 新增人格只改配置文件。
5. 私聊无冷却、有去抖；群聊默认 @ 触发 + 合并 + 冷却。
6. 闲时主动默认关；随机插话设计但默认关。
