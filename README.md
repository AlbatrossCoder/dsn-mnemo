# dsn-plugins

DeepSeek Harness 插件集合（pnpm workspace monorepo）。

| 包 | 说明 |
|---|---|
| [packages/dsn-mnemo](packages/dsn-mnemo) | 记忆运行时：L0 原文 / L1 日记 / L2 锚点，零第三方运行时依赖 |
| [packages/dsn-whale-chat](packages/dsn-whale-chat) | 鲸鱼娘 QQ 聊天插件（OneBot 通道 + 双人格 + 频率控制），设计阶段 |

两个插件解耦：`dsn-whale-chat` 负责把 QQ 消息送进 DSH 并带上身份，`dsn-mnemo` 负责记忆，互不依赖。

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
