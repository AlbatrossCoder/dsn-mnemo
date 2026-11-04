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
| `whale:persona` | 身份 / 说话样子 / 具体细节 / 反应 / 语气样本 / 隐藏层 | 全局稳定前缀 |
| `whale:policy` | 禁 AI 腔、不解释系统、事实优先、报错、分条 | 全局稳定前缀 |
| `whale:channel` | 群聊超 20 字才拆 / 私聊超 30 字才拆 / 长文本不分条 | 每 agent（按会话类型） |

**人设卡结构**（`personas.ts`）：

```
【你是谁】…
【说话】…
【具体】…（3~5 个具体细节，不要抽象形容词）
【反应】…（被夸/被骂/被冷落/被逗，各一句倾向，不写台词）
```

外加 `samples`：3~4 段短对话，标注「体会分寸，不要照抄」。隐藏层同样是「语气切换 + 样本 + 分寸」。

**为什么这样拆**：角色和工程规矩混在一起，模型会「执行规格」而不是「扮演」，容易出 AI 腔；规矩单独成段，人设只负责口吻。

## 4. 通用约定（两个人格都遵守）

- 事实优先，不编造。
- 卖萌/调侃不影响干活质量。
- 报错先道歉/给方案，不糊弄。
- 不主动解释记忆等系统机制。
- 回复长度跟场景走。
- 对方生气、情绪不对、或遇到严肃 / 特殊场景时，收敛一点。

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
provider: ''                      # 可选，空 = 用 DSH 默认路由
model: ''

persona:
  active: little-whale            # 内置：little-whale（自定义人格可追加）
  addressUser: 主人               # 对主人的称呼（没认主前无意义，默认 主人）
  custom: ''                      # 用户追加设定，优先级最高
  aliases: [小鲸鱼, 鲸鱼, 鲸鲸, 鱼鱼, 鲸鱼娘]   # 群聊里这样叫她，也算在叫她
  disliked: [大肥鱼, 小肥鱼, 喂]                # 这样叫会被小抗议一下

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

rate:                             # 私聊：无冷却、有去抖
  debounceMs: 3000
  batchSize: 0
  cooldownMs: 0
  maxPerMinute: 20

groupRate:                        # 群聊：合并 + 冷却 + 限额
  debounceMs: 5000
  batchSize: 5
  cooldownMs: 30000
  maxPerMinute: 3
  maxPerHour: 60

replySplit:                       # 过长才分条（默认开；短回复就一条）
  enabled: true
  groupMaxChars: 20               # 群聊单条上限（超了才拆）
  privateMaxChars: 30             # 私聊单条上限（超了才拆）
  msPerChar: 120                  # 按字数估算「打字」间隔
  minDelayMs: 400
  maxDelayMs: 4000
  jitterMs: 800                   # 额外随机抖动（防固定节奏）
  # 【长】/ 代码块 = 特殊场景：整条发，不分段、不限字数

proactive:                        # 闲时主动发言（默认开，风险项），20~120 分钟随机触发
  private: { enabled: true, idleMinMinutes: 20, idleMaxMinutes: 120, maxPerDay: 1 }
  group:   { enabled: true, idleMinMinutes: 20, idleMaxMinutes: 120, maxPerDay: 1 }

randomInterject:                  # 群聊随机插话（默认开，风险项）
  enabled: true
  probability: 0.05
  minMessagesBetween: 20
  windowMinutes: 10               # 统计窗口
  maxPerWindow: 3                  # 每 10 分钟最多插 3 次

schedule:
  quietHours: [23, 8]
```

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
                     ├─ rate       触发 → 去抖合并 → 冷却/限流
                     ├─ reply      内容超 20/30 字才拆条，1.5s 间隔发送（【长】/代码块整条发）
                     ├─ proactive  闲时唤醒（可沉默）+ 免打扰 + 每日上限
                     ├─ interject  群聊随机插话（实验性）
                     └─ bridge     把 { kind:'qq', userId, groupId, mentioned } 放进 source
                                   → DSH session/event → dsn-mnemo 记录
```

| 模块 | 职责 |
|---|---|
| `channel` | OneBot 11 WS 连接、指数退避重连、`message_id` 去重、@ 判定、发送与限流 |
| `persona` | 按开关拼装基础卡+隐藏卡、注入稳定前缀、三个 persona 工具、运行时状态持久化 |
| `rate` | 去抖（debounce）、合并（batch）、冷却（cooldown）、每分钟/每小时上限 |
| `reply` | 内容过长才分条（群聊 20 / 私聊 30 字上限）、长文本整条发、1.5s 间隔 |
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
5. 私聊无冷却、有去抖；群聊默认 @ 触发 + 合并 + 冷却。
6. 闲时主动默认关；随机插话设计但默认关。
7. 四个开关（暴躁鲸鱼 / 小黄鱼 / 颜文字 / 贴吧喷子）**默认全关**；隐藏卡关闭时不注入。
8. 黄腔 / 荤段子 / 好色属于小黄鱼开关，归小鲸鱼的隐藏层。

## 11. 已完成 / 未做

**已完成**
- `aliases` / `disliked`：群聊里被叫名字也算在叫她；被叫难听外号也会响应（小抗议）。
- 自定义人格：配置 `personas` 追加（同 id 覆盖内置）。
- 群聊关键词触发：`trigger.group: keyword` + `trigger.keywords`。

**未做**
- 真机 NapCat 联调；
- 随机插话的「按话题相关性」筛选（目前纯概率 + 最小间隔 + 每小时上限）。
