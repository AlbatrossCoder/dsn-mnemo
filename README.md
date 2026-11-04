# dsn-plugins

DeepSeek Harness 插件集合（pnpm workspace monorepo）。

## 插件

### dsn-mnemo · 记忆运行时

让「想起」发生在正确的时机，以正确的形态。它记录跨会话的聊天原文，把值得留下的沉淀成日记，到日子时用锚点提醒——全部存在本地 SQLite 里，零第三方运行时依赖，**全程不调用模型**。

- **三层记忆**：L0 原文 / L1 日记 / L2 锚点
- **主体化**：私聊归 `user:<id>`、群聊归 `group:<id>`，跨主体隔离
- **按需检索**：`recall` 深掘、前置浮现、锚点提醒

详见 [packages/dsn-mnemo](packages/dsn-mnemo)。

### dsn-whale-chat · 鲸鱼娘 QQ 聊天插件

把 QQ 接进 DSH：OneBot 通道 + 双人格（小鲸鱼·萝莉 / 大鲸鱼·御姐）+ 聊天频率控制。人格可改可加，另有「恶趣味 / 女王 / 颜文字」三个开关；**记忆交给 dsn-mnemo，本插件不内置记忆**。

- **通道**：OneBot 11（NapCat / SnowLuma 等外部协议实现）
- **人格**：基础卡 + 隐藏卡，开关关闭时不注入
- **频率**：触发 → 去抖合并 → 冷却/限流，群聊默认只 @

状态：设计阶段，骨架已建。详见 [packages/dsn-whale-chat](packages/dsn-whale-chat)。

> 两个插件解耦：`dsn-whale-chat` 负责把 QQ 消息送进 DSH 并带上身份，`dsn-mnemo` 负责记忆，互不依赖。

## 开发

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

## 文档

- `packages/dsn-mnemo/docs/`：记忆模型、多用户适配
- `packages/dsn-whale-chat/docs/`：聊天插件设计、人格卡（`persona/`）、QQ 接入
