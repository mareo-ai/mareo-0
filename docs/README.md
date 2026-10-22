# 文档地图

先读 [README](../README.md) 知道这是什么，再按你的任务挑下面的一条路走。

## 按任务找入口

| 你要做什么 | 读这几份 |
|---|---|
| **第一次接手项目** | [architecture.md](architecture.md) → [current-state.md](current-state.md) → [agents-landing.md](agents-landing.md) |
| **改客户端**（Electron / 品牌插件 / 启动） | [architecture.md](architecture.md) 的「接缝」一节 → [session-log-downgrade.md](session-log-downgrade.md) |
| **改网关或计费** | [gateway.md](gateway.md) → [`money/standard.md`](money/standard.md)（钱的口径，改前必读） |
| **部署 / 运维网关** | [gateway-deploy.md](gateway-deploy.md) |
| **发版** | [release.md](release.md) → [signing.md](signing.md)；Windows 见 [build-windows.md](build-windows.md) |
| **看运营数据** | [operations.md](operations.md) |
| **改 UI / 页面** | [design/product-design-principles.md](design/product-design-principles.md) → [design/themes/dashboard.md](design/themes/dashboard.md) → [design/web-interface-guidelines.md](design/web-interface-guidelines.md) |
| **改隐私说明** | `docs/privacy.md` 与 `website/privacy.html` **必须同步**，英文版 `privacy-en.html` 一起改 |
| **查"现在是什么状态"** | [current-state.md](current-state.md)（唯一来源，带核对日期） |
| **遇到报错 / 排查故障** | [troubleshooting.md](troubleshooting.md)（按症状索引） |
| **改官网** | [website.md](website.md) |

## 规则在哪

| 规则 | 位置 |
|---|---|
| 协作方式、代码质量、**动钱必须先写文档** | [AGENTS.md](../AGENTS.md)（最高优先级） |
| 智能体的生产权限、文件接触面分工、并行工作隔离 | [agents-landing.md](agents-landing.md) |
| 钱的唯一口径（单位、倍率、扣减顺序、账本、报表定义） | [money/standard.md](money/standard.md) |
| 每一项钱的变更的决策记录 | [money/designs/](money/designs/)（按日期，先于代码） |

## 目录约定

```
docs/
├── README.md                 ← 本文件：地图与导航
├── architecture.md           系统怎么组成、数据怎么流、哪些接缝不能碰
├── current-state.md          唯一状态来源（版本/schema/账号数/已知问题）
├── agents-landing.md         智能体接手：权限、接触面、并行隔离
├── gateway.md                网关：路由、表结构、计费、额度、支付、双上游
├── gateway-deploy.md         网关部署与运维（阿里云 + 境外出口）
├── operations.md             运营口径：看什么、怎么算、多久看一次
├── website.md                官网：页面结构、部署、下载清单、浏览计数
├── troubleshooting.md        排查手册：按症状索引，踩过的坑都在这里
├── release.md / signing.md / build-windows.md    发布链路
├── updates.md                客户端更新机制（当前是提示式）
├── session-log-downgrade.md  会话日志与运行时降级（回滚风险）
├── privacy.md                隐私说明（与 website/privacy.html 同步）
├── oss-setup.md              安装包托管（阿里云 OSS）
├── sponsored-ad.md           推荐位（当前默认关闭）
├── design/                   UI 规范、主题、审查清单
├── money/                    钱的规则与设计记录
│   ├── standard.md           权威口径
│   └── designs/              每次改动的决策记录
└── archive/                  已完成的计划与历史文档（只读，不维护）
```

## 写文档的三条约定

1. **状态不散落**：版本号、schema 版本、账号数这类会变的事实，只写在 [current-state.md](current-state.md)，并带 `最后核对` 日期。其它文档引用它，不复制。
2. **能跑的命令才写进文档**：写命令前先执行一次。历史上 `npm run cost`（根目录不存在）这类错误就是没跑就写下来的。
3. **历史文档不追改**：决策记录（`money/designs/`、`design/2026-*`）里的旧版本号是当时的事实，不改；只要在标题标明日期即可。
4. **踩过的坑必须回流**：修完一个非平凡问题，**在同一个分支**里往 [troubleshooting.md](troubleshooting.md) 加一条（症状 → 根因 → 怎么确认 → 修法）。只写在 PR 描述里等于没写——PR 不会有人回头翻。
