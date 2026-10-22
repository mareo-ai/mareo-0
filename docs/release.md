# 发布流程（tag 驱动，CI 自动出包）

一次发布 = **打一个版本 tag**，其余全自动。推荐用一键脚本，它会问你要版本号、更新说明和是否强制更新：

```sh
npm run release                 # 交互式（推荐）
npm run release -- --dry-run    # 只看计划
```

脚本内部做的事（也可以手工执行）：

```sh
# 1. 提升版本号（唯一真正的人工步骤）
#    package.json 的 "version": "0.1.3"
git commit -am "Release 0.1.3"
# 2. 打 tag：第一行是用户看到的更新说明，minimum-version 行表示强制更新
git tag -a v0.1.3 -m "修复账户隔离问题" -m "minimum-version: 0.1.2"
git push --atomic origin main v0.1.3
```

## 触发与产物

| 触发 | 行为 |
|---|---|
| `push tag v*` | 校验版本 → macOS 构建/签名/公证 → Windows 构建/签名 → 发布（上传 + 清单 + GitHub Release） |
| 手动 `workflow_dispatch` | **只构建**，产物留在 Artifacts，不动线上（干跑用） |

发布任务会：
1. 收集两端安装包（含 Windows 的 `.nupkg` 与 `RELEASES`，为将来自动更新备用）
2. 生成 `updates/latest.json`（版本、发布时间、两端下载直链）
3. 上传到 OSS（若已配置）
4. **镜像官网文件到官网主机，再把最新清单写过去**（若配置了 `ECS_HOST`/`ECS_SSH_KEY`）；先同步页面、后更新清单，避免出现"新页面读到旧清单"的空窗
5. 创建 GitHub Release（附全部产物，作为审计与备用下载源）

## 官网部署

官网的页面结构与维护约定见 [website.md](website.md)。官网文件由发布流程自动同步（`scripts/deploy-site.mjs`），所以改了 `website/` 之后**必须在发版后才会生效**。需要立刻上线（例如只改了文案，不想发版）时，本地跑同一条命令：

```sh
ECS_HOST=root@114.55.15.112 MAREO_DEPLOY_KEY=~/.ssh/mareo-0.pem npm run deploy:site
npm run deploy:site -- --dry-run          # 只看会执行什么
```

它用 `rsync --delete` 把 `website/` 镜像到 `/var/www/mareo-site/`，并：

- **排除 `updates/`（发布清单）和 `downloads/`（旧链接 302 目标）**——这两个目录由发布流程独占，任何情况下都不该被网站同步覆盖或删除；
- 用 `--chmod=Fu=rw,Fgo=r` 上传，否则本地权限是 600 的文件（macOS 下新建文件常见）会让 nginx 403；
- 同步后自动校验首页、`/privacy.html` 与首屏大图都返回 200，校验失败即报错退出。

## 命名规范

```
Mareo-<version>-<os>-<arch>[-<variant>].<ext>

Mareo-0.1.1-macos-arm64.dmg          # 给人下载（签名+公证）
Mareo-0.1.1-macos-arm64.zip          # （Phase 2）给更新器
Mareo-0.1.1-windows-x64-setup.exe    # 给人下载
MareoSetup.exe                       # 固定名副本：Squirrel 更新链要求
Mareo-0.1.1-windows-x64-full.nupkg   # （Phase 2）给更新器
RELEASES                             # （Phase 2）Squirrel 更新索引
```

- `os`：`macos` / `windows` / `linux` / `harmony`
- `arch`：`arm64` / `x64`
- 未来平台沿用同一规则（Linux `.AppImage`、鸿蒙 `.hap`）
- 自动化位置：`forge.config.cjs` 的 `postMake` 钩子负责改名/生成版本化副本

## 需要的 Secrets（Settings → Secrets and variables → Actions）

| 用途 | Secret |
|---|---|
| macOS 签名 | `MACOS_CERT_P12_BASE64`、`MACOS_CERT_PASSWORD` |
| macOS 公证 | `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` |
| Windows 签名（必需） | `SSLTRUS_ACCESS_KEY`、`SSLTRUS_ACCESS_SECRET`、`SSLTRUS_CERT_CODE`（云签名，见 [`signing.md`](signing.md)） |
| OSS 上传 | `OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` |
| 官网部署与清单更新（可选） | `ECS_HOST`（如 `root@114.55.15.112`）、`ECS_SSH_KEY`（部署私钥内容） |

变量（Variables）：`RELEASE_DOWNLOAD_BASE` —— 清单里下载链接的前缀，设为 `https://mareo-downloads.oss-cn-hangzhou.aliyuncs.com`。

未配置的步骤会**自动跳过并打印提示**，所以可以先只配 Apple 证书跑通，再逐步接入 OSS。

## 下载托管（OSS 直连）

安装包托管在阿里云 OSS，直连下载；完整步骤见 [`oss-setup.md`](oss-setup.md)。要点：

- Bucket 保持**公共读**，地址形如 `https://mareo-downloads.oss-cn-hangzhou.aliyuncs.com/...`
- 变量 `RELEASE_DOWNLOAD_BASE` 设为该地址
- 已发布客户端里的旧链接 `mareo.cn/downloads/...` 由 nginx 302 到 OSS

## 官网下载链接

官网已改为**运行时读取 `updates/latest.json`**（`website/app.js`），所以发版**不再需要改站点代码**；清单不可达时回退到内置链接。

## 回滚

- 清单回滚：把 `updates/latest.json` 改回上一版本（用户端提示会消失）
- 安装包保留：OSS/ECS 上旧版本文件不删，便于用户重新下载
- GitHub Release 保留每个版本的产物，必要时可重新分发

## 干跑与验证

- 手动触发 Release workflow（不推 tag）→ 只构建、只出 Artifacts
- 本地验证 macOS 包：`spctl -a -t exec -vv out/Mareo-darwin-arm64/Mareo.app`
- 验证清单：`curl -s https://mareo.cn/updates/latest.json`
