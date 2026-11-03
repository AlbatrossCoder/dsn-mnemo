# 发布 dsn-mnemo 到 DSH 插件市场

DSH 的「插件市场」不是上传中心，而是**索引驱动**：用户添加一个索引 URL，市场按索引里的条目安装对应版本。所以发布 = **发布 npm 包（或 Git 仓库）+ 托管一份索引 JSON**。

本仓库已经具备所需的一切：

- `package.json` 的 `dsh.bundle.patch` 指向 [cordis.patch.yml](../cordis.patch.yml)，安装后自动向 profile 插入 `dsn-mnemo` 这一行；
- `engines.dsh` 声明兼容的 DSH 版本；
- `market-index.json` 是当前仓库对应的索引（由脚本生成、已用 DSH 的 `parseMarketIndex` 校验）。

---

## 0. 推送到 GitHub

远端已配置好（`origin` → `https://github.com/AlbatrossCoder/dsn-mnemo.git`）：

```powershell
git push -u origin main
```

之后每次改动：`git add -A && git commit -m "..." && git push`。

---

## 1. 发布 npm 包

```powershell
# 1) 登录（只需一次）
npm login

# 2) 确认包名没被占用
npm view dsn-mnemo version

# 3) 发布前把 DSH 自带 Node 加进 PATH（prepack 里的 tsc 需要 node）
$env:PATH = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"

# 4) 发布（prepack 会先构建 lib/）
pnpm publish --access public
```

不想发 npm 也可以走 Git：索引里用 `source: { type: "git", url, commit }`，`commit` 必须是 40 位 SHA；安装时用 `git+https://...#<sha>`。

> `package.json` 必须保存为**无 BOM 的 UTF-8**。带 BOM 时 DSH 读取清单失败，插件行会被静默禁用（本项目踩过这个坑）。

---

## 2. 生成索引

```powershell
node scripts\make-market-index.mjs --repo https://github.com/AlbatrossCoder/dsn-mnemo
node scripts\validate-market-index.mjs market-index.json   # 可选的独立校验
```

`--git --commit <sha>` 生成 Git 源版本；`--version` 覆盖版本号；`--out` 指定输出。

索引要点（格式 1）：

- 顶层 `format: 1`、`title`（至少含 `en`）、`plugins[]`；
- 每个插件 `name`（npm 包名）与 `versions[]`：`version`、`publishTimestamp`（Unix 秒）、`source`、可选 `engines.dsh`；
- 可选 `metadata.categories / labels / sortKeys` 用于分类筛选。

**每次发新版都要重新生成索引**（版本号与 `publishTimestamp` 会变），然后重新托管。

---

## 3. 托管索引

索引必须是任意 **HTTPS 直链**，不能带凭据、查询串或片段，且不能经过重定向。几种省事的方式：

| 方式 | 得到的 URL 形如 | 说明 |
|---|---|---|
| GitHub Pages（仓库根目录） | `https://albatrosscoder.github.io/dsn-mnemo/market-index.json` | 在仓库 Settings → Pages 选 `main` / root，等一分钟生效 |
| 仓库内的文件 + Raw | `https://raw.githubusercontent.com/AlbatrossCoder/dsn-mnemo/main/market-index.json` | 直接可读；注意 Raw 不能是重定向 |
| 自己的静态站点 / 对象存储 | `https://你的域名/market-index.json` | 需要允许匿名 GET |

托管后先用浏览器打开一次，确认拿到的是 JSON。

---

## 4. 用户怎么装

GUI：**插件 → 发现 → 添加索引源**（粘贴上面的 URL）→ 搜索 `dsn-mnemo` → 安装。安装由 `pluginManager.installBundle` 执行 `pnpm add dsn-mnemo@<version>`，并把该组合包追加到 profile 的 `dsh.profile.bundles`。

CLI（非 desktop profile）：

```powershell
dsh plugin --profile <profile> add dsn-mnemo@0.6.1
```

安装后首次启动时插件 `apply()` 会自动：

1. 展开 `~` 并按需创建父目录；
2. 创建 `~/.dsh/mnemo/mnemo.db`（WAL）；
3. 跑迁移建表（`messages`/`diaries`/`anchors`/`sessions`/`work_state`/`diary_revisions` 与两张 FTS5 表）。

用户不需要手动建库、跑 SQL 或装 SQLite——`node:sqlite` 是 DSH 自带的。装了插件、重启一次（或 HMR 生效）就能用。

---

## 5. 发新版本

1. 改代码，`pnpm build && pnpm test`；
2. 升 `package.json` 的 `version`；
3. `git commit && git push`；
4. `pnpm publish --access public`；
5. 重新生成并托管索引；
6. 用户在「发现」里看到「有新版本」，但 DSH 目前**没有升级按钮**——需要卸载再安装（这是 DSH 的已知限制）。

---

## 6. 卸载与隐私

- 卸载组合包不会删除 `~/.dsh/mnemo/mnemo.db`；需要清空记忆时手动删除该文件（或整个目录）。
- 记忆是**本地明文 SQLite**，不会上传；`dbPath` 可在 profile 的插件配置里改。
- 不要把 `dbPath` 放在 OneDrive 等同步目录，Windows 上文件锁可能导致迁移失败。
