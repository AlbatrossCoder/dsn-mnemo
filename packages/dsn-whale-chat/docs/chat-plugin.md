# 聊天插件设计（鲸鱼娘 QQ 接入）

> 插件名：**`dsn-whale-chat`**（npm 已查：空闲；备选见 §9）
>
> 定位：QQ 通道 + 双人格 + 聊天频率控制。记忆不在这里做，全部交给 `dsn-mnemo`。
>
> 人格文档（`docs/persona/`）：
> - [小鲸鱼（萝莉）](persona/little-whale.md) · [小鲸鱼隐藏（恶趣味 / 贴吧喷子 / 女王）](persona/little-whale-hidden.md)

## 0. 设计原则

1. **描述特征，不写台词**：人格写的是「她是什么样的人、遇到什么会怎么反应」，不是「被夸时说哪句话」。示例只作举例，模型每次按情境现编，不要照抄。
2. **两个人格各自完整**：每人格一份基础卡，性格、反应、口癖、硬规矩独立写，不互相借用。
3. **隐藏人格独立成卡、开关控制**：关闭时不注入，省 token、也不泄底。
4. **名字可自定义，称呼有偏好**：能接受一批昵称，也会讨厌几个失礼的叫法。
5. **记忆归记忆插件**：本插件不内置记忆、不写日记文件，只负责「把 QQ 消息变成 DSH 会话」。

## 1. 名字与称呼系统

| 项 | 默认 | 说明 |
|---|---|---|
| `name` | 小鲸鱼 | 显示名，用户可改成任意（如「鲸鱼娘」「阿鲸」） |
| `aliases` | 小鲸鱼、鲸鱼、鲸鲸、鱼鱼、鲸鱼娘 | 能接受的称呼，用户可追加（**待实现**） |
| `disliked` | 大肥鱼、小肥鱼、喂 | 听到会抗议，但不生气、不失礼（**待实现**） |
| `addressUser` | 哥哥（小）/ 你（大） | 怎么称呼用户，可配置（已实现） |

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

## 3. 人格变体与开关

每个人格 = **基础卡**（总是注入）+ **隐藏卡**（开关打开才注入）。

| 人格 | 隐藏模式 | 开关 | 内容 |
|---|---|---|---|
| 小鲸鱼 | 暴躁鲸鱼 | `toggles.mischief` | 暴躁、粗口、低俗、口头禅 |
| 小鲸鱼 | 贴吧喷子 | `toggles.troll` | 抬杠、阴阳怪气、贴吧梗（不骂脏话） |
| 小鲸鱼 | 小黄鱼 | `toggles.queen` | 黄腔、荤段子、好色 |

**注入规则（关键）**：
- 基础卡：当前人格激活时**总是注入**；
- 每个隐藏卡：**只有对应开关为 `true` 时才注入**；关闭时，这段文本**完全不进入上下文**（省 token，也不让模型知道有这些内容）；
- `kaomoji` 开关：关闭时去掉颜文字相关条目，并追加一条「不要使用颜文字」；**emoji 默认允许**（和颜文字、表情包不是一回事）；
- 情欲向内容**建议只在私聊开**，群聊默认不启用。

## 3.5 三层注入与人设写法

注入分三层，**角色（怎么说话）和规矩（怎么干活）解耦**：

| 层 | 内容 | 位置 |
|---|---|---|
| `whale:persona` | 人物背景（来历 / 生活 / 身体 / 性格 / 在意 / 关系）和已打开的隐藏层 | 全局稳定前缀 |
| `whale:policy` | 规则本身、不解释系统、不确定就说不确定、只有主人能改人设和开关 | 全局稳定前缀 |
| `whale:channel` | 群还是私聊、换行会分成多条、主人是谁、这一轮的消息状况 | 每 agent |

人物背景只写事实，不写台词样本。隐藏层只有对应开关打开才注入。

**为什么这样拆**：角色和工程规矩混在一起，模型会「执行规格」而不是「扮演」，容易出 AI 腔；规矩单独成段，人设只负责口吻。

## 4. 通用约定（两个人格都遵守）

- 不确定就说不确定，不编造。
- 不解释记忆、系统和插件。
- 只有主人能改人设和开关。

## 5. 时段控制

```yaml
schedule:
  quietHours: [23, 8]     # 免打扰（跨零点）：这段时间不主动发言
```

- **私聊**：`quietHours` 只限制「主动发言」，你主动找她时照常回复。
- **群聊**：`quietHours` 可同时限制主动发言与随机插话。

## 6. 配置（与实现一致）

写进 `cordis.patch.yml` 的 `config`（没有外层 `chat:` 包装）：

```yaml
wsUrl: 'ws://127.0.0.1:3001'      # OneBot WS
accessToken: ''
statePath: '~/.dsh/whale-chat-state.json'   # 名字/称呼/custom/开关的运行时状态
balanceCachePath: '~/.dsh/dsh-balance-view/cache.json'   # get_balance 读的缓存（dsh-balance-view 写的）
provider: ''                      # 可选，空 = 用 DSH 默认路由
model: ''

persona:
  active: little-whale            # 内置：little-whale（自定义人格可追加）
  addressUser: 主人               # 对主人的称呼（没认主前无意义，默认 主人）
  custom: ''                      # 用户追加设定，优先级最高
  aliases: [小鲸鱼, 鲸鱼, 鲸鲸, 鱼鱼, 鲸鱼娘]   # 自称/人设用；不负责叫醒
  disliked: [大肥鱼, 小肥鱼, 喂]                # 嫌称记录；不负责叫醒

owner:                            # 唯一的最大权限用户（认主）
  userId: ''                      # 空 = 未认主；第一条私聊自动认主（claim=true 时）
  nickname: ''                    # 展示用，可空
  role: 主人                      # 主人 / 家长 / 自定义
  claim: true                     # 允许首条私聊自动认主；认主后锁死

# 追加自定义人格（同 id 覆盖内置）
personas:
  - id: my-dolphin
    name: 小海豚
    base: |
      你是一只小海豚……

toggles:                          # 四个开关默认全关
  mischief: false                 # 小鲸鱼暴躁鲸鱼
  queen: false                    # 小鲸鱼小黄鱼
  kaomoji: false                  # 颜文字（emoji 默认可用）
  troll: false                    # 小鲸鱼贴吧喷子

trigger:
  group: at                       # 群聊只 @（也可 all / keyword）
  keywords: []                    # group=keyword 时，命中这些词也算在叫她

rate:                             # 私聊：入站去抖 + 发送节奏
  debounceMs: 3000
  batchSize: 0                    # 收到这么多条就提前处理（0=只按去抖）
  cooldownMs: 0                   # 一轮结束后的停顿
  minGapMs: 1000                  # 两条消息之间的最小间隔
  maxPerMinute: 15
  maxPerHour: 200

groupRate:                        # 群聊：同上
  debounceMs: 5000
  batchSize: 0                    # 收到这么多条就提前处理（0=只按去抖）
  cooldownMs: 0
  minGapMs: 2000
  maxPerMinute: 8
  maxPerHour: 80

inbox:
  maxMessages: 10                 # 待处理列表上限，满了丢最新

replySplit:
  enabled: true
  platformMaxChars: 4500          # 单条超过这个长度才在句末切开；不截断
  # 没有字数规则：分不分段由模型自己决定

typingStatus: true                # 私聊“正在输入”（NapCat 支持；SnowLuma 可关）

proactive:                        # 闲时主动：私聊默认开，群聊默认关；20~200 分钟随机
  private: { enabled: true,  idleMinMinutes: 20, idleMaxMinutes: 200, maxPerDay: 1 }
  group:   { enabled: false, idleMinMinutes: 20, idleMaxMinutes: 200, maxPerDay: 1 }

randomInterject:                  # 群聊随机插话（默认开，风险项）
  enabled: true
  probability: 0.05
  minMessagesBetween: 20
  windowMinutes: 10               # 统计窗口
  maxPerWindow: 1                  # 每 10 分钟最多插 1 次，且只发 1 条

schedule:
  quietHours: [23, 8]
```

## 6.5 兼容 NapCat / SnowLuma

两者都是 OneBot 11，插件协议层不用改，只按下面配：

| 项 | NapCat | SnowLuma |
|---|---|---|
| WS 地址 | `ws://127.0.0.1:3001` | 默认也是 `3001`，以它 WebUI 的 OneBot 配置为准 |
| 鉴权 | `?access_token=` | 同左 |
| **消息格式** | 必须 `array` | **也必须 `array`**（CQ 码字符串会导致 @ 识别不到） |
| 私聊“正在输入” | 支持 `set_input_status` | 不一定支持 → 把 `typingStatus` 设为 `false` |
| 自己发的消息 | `message_sent` 会被忽略 | 同左 |

注意：`@` 的 `qq` 字段 number/string 都能识别；`user_id` / `group_id` 也兼容两种类型。

## 6.6 余额查询（get_balance）

本插件内置了一个 `get_balance` 工具，**不需要装别的余额插件**：

- 工具内部通过 `ctx.get('deepseekAccount')` 调宿主账号服务的 `getBalance()`；
- 返回 `total / recharge / bonus / currency / checkedAt`（充值钱包 + 赠金）；
- 没登录、账号服务没就绪、没有钱包时返回错误，不编数字。

前提：DSH 已登录 DeepSeek 账号（profile 里用了 `deepseek-account` 这个 provider）。

主人私聊问她「查一下余额」，她就会调这个工具报出数字。

## 7. 修改方式（分层）

| 改什么 | 方式 | 存哪 |
|---|---|---|
| **人格卡本体 / 隐藏卡** | 手动改代码里的 `personas.ts` | 源码 |
| **新增人格** | 手动加进 `BUILT_IN_PERSONAS` | 源码 |
| **开关**（恶趣味/女王/颜文字/贴吧喷子） | 配置默认 + 可对话切换（`persona_toggle`） | 运行时状态，覆盖配置 |
| **名字 / 怎么称呼你 / `custom`** | 对话（模型调 `persona_set`） | 运行时状态，覆盖配置 |
| **切换人格**（内置小鲸鱼，或已追加的自定义人格） | 对话/工具 `switch_persona` | 运行时状态 |

- `persona_set` / `persona_toggle` / `switch_persona` 只在用户明确要求时触发，不许模型自作主张。
- 核心人格（traits/quirks）不开放运行时修改。

## 8. 架构与模块

```
QQ ──OneBot WS──▶ dsn-whale-chat
                     ├─ channel    OneBot 连接 / 去重 / @ 判定 / 回发 / 重连
                     ├─ persona    基础卡 + 隐藏卡按开关拼装、稳定前缀注入
                     │              persona_set / switch_persona / persona_toggle
                     ├─ inbox      每个会话一条待处理列表（私聊约 2 秒、群聊约 4 秒去抖）
                     ├─ reply      换行分条；超平台上限才按句切开；一次回复最多约 800 字
                     │             每条先等再发；私聊等待开始时 set_input_status
                     ├─ proactive  闲时唤醒（可沉默）+ 免打扰 + 每日上限
                     ├─ interject  群聊随机插话（实验性）
                     └─ bridge     把 { kind:'qq', userId, groupId, mentioned } 放进 source
                                   → DSH session/event → dsn-mnemo 记录
```

| 模块 | 职责 |
|---|---|
| `channel` | OneBot 11 WS 连接、指数退避重连、`message_id` 去重、@ 判定、发送与限流 |
| `persona` | 按开关拼装基础卡+隐藏卡、注入稳定前缀、三个 persona 工具、运行时状态持久化 |
| `inbox` | 入站列表。少于 3 条为正常，3 到 5 条为加急，多于 5 条为堆积。满 10 条后新消息不再入列。列表不空时不主动发言、不插话 |
| `reply` | 换行是一条消息，代码块保持整段。短句等待约 1.5–2.5 秒，更长的约 2.5–4 秒。全账号一条发送队列：群至少隔 2 秒、每分钟 8 条、每小时 80 条；私聊至少隔 1 秒、每分钟 15 条、每小时 200 条 |
| `proactive` | 空闲计时、免打扰、每日上限、`SILENT` 可沉默 |
| `interject` | 概率 + 最小间隔 + 每小时上限的随机插话闸门 |
| `bridge` | 构造 `UserMessage.source`（身份）、`agent.followup()`、监听 `assistant/message` 回发 |

## 9. 插件名备选

| 名字 | 含义 | 评价 |
|---|---|---|
| **`dsn-whale-chat`** | 直白 | 推荐，搜索好找 |
| `dsn-tide` | 潮汐，隐喻聊天节奏 | 有味道，但不够直白 |
| `dsn-song` | 鲸歌，鲸鱼靠歌声交流 | 贴主题，稍微抽象 |

## 10. 已定

1. 称呼统一：小鲸鱼叫「主人」（可被认主流程改），不再有第二人格的「小家伙」。
2. 不自动切换人格，默认只手动 `switch_persona`。
3. `activeHours` 先不做正式配置。
4. 新增人格只改源码（`personas.ts`）。
5. 私聊、群聊各自去抖后交给她处理；发送额度按全账号的 QQ 条数算，不再按唤醒次数冷却。
6. 闲时主动：私聊默认开（20~200 分钟随机），群聊默认关；随机插话默认开。
7. 四个开关（暴躁鲸鱼 / 小黄鱼 / 颜文字 / 贴吧喷子）**默认全关**；隐藏卡关闭时不注入。
8. 黄腔 / 荤段子 / 好色属于小黄鱼开关，归小鲸鱼的隐藏层。

## 11. 已完成 / 未做

**已完成**
- 群聊主动叫醒：仅 `@`，或正文里出现**当前显示名**（主人取的名字；未改名时仍是「小鲸鱼」）。别名 / 嫌称 / keyword 不叫醒。
- `aliases` / `disliked`：人设与嫌称记录，不负责叫醒。
- 自定义人格：配置 `personas` 追加（同 id 覆盖内置）。
- 跟聊 / 插话 / 闲时主动：逻辑独立，不走「叫醒」判定。

**未做**
- 真机 NapCat 联调；
- 随机插话的「按话题相关性」筛选（目前纯概率 + 最小间隔 + 每小时上限）。
