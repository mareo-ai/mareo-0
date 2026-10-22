# Mareo

macOS 与 Windows 上的桌面客户端，把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打包成一个开箱可用的应用：不用装 Node、不用配 API key、不用碰命令行。

用户只面对 Mareo 账号；模型调用经 Mareo 网关转发，厂商密钥只存在于服务器。

## 现在能做什么

| 能力 | 状态 |
|---|---|
| macOS（arm64）+ Windows（x64） | ✅ 已发布，安装包已签名（macOS Developer ID + 公证；Windows OV 云签名） |
| 模型 | ✅ `Mareo-D-V41-Flash`、`Mareo-D-V4-Pro`（DeepSeek）；`Mareo-O-6-Sol`、`Mareo-O-6-Astra`（OpenAI） |
| 账号 | ✅ 邮箱验证码登录；额度条显示今日免费额度与余额 |
| 付费 | ✅ 支付宝扫码充值（微信待商户号） |
| 更新 | ⚠️ 提示式：检查到新版本会提示并给下载链接，可设最低版本强制更新；**不会**自动下载安装 |
| 图片输入、联网搜索 | ✅ 由模型目录声明，未在代码里硬编码 |

当前版本号与已发布版本、已知问题都在 [docs/current-state.md](docs/current-state.md)——**这里是唯一的"现在是什么状态"**。

## 5 分钟跑起来

```sh
npm ci                       # 客户端依赖
npm --prefix server ci       # 网关依赖
npm start                    # 起 Electron（会先 stage 运行时）
```

需要 Node >= 24（网关用内置 `node:sqlite`）。从源码跑时客户端默认连本机网关 `http://127.0.0.1:3000`，
打包版连 `https://api.svc.mareo.cn`；`MAREO_GATEWAY_URL` 可覆盖两者。

本地网关：

```sh
cd server
cp .env.example .env        # 填你自己的 DEEPSEEK_API_KEY
npm start                   # 网关在 http://127.0.0.1:3000
npm run issue-token -- Alice # 签发一个登录令牌
```

## 常用检查

```sh
npm run typecheck
npm test                       # 客户端测试
npm --prefix server test       # 网关测试
npm run verify:runtime         # 钉版 DSH + Node 校验
npm run verify:brand           # 插件组成 + 鉴权 Web 能否启动
npm run dev                    # 改界面：复用依赖、只同步品牌插件，⌘R 生效
```

## 打包

```sh
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run make
npm run verify:package
```

> 这台机器直连 GitHub 会超时，`ELECTRON_MIRROR` 不是可选项。产物在 `out/Mareo-darwin-arm64/Mareo.app`
> 与 `out/make/`。Windows 必须在 Windows 上构建，见 [docs/build-windows.md](docs/build-windows.md)。

## 结构

```
src/        Electron 主进程：启动编排、登录、DSH 生命周期、更新检查、模型目录、品牌 overlay
brand/      注入 DSH 的客户端插件：额度条、充值面板、推荐位
runtime/    DSH 与 Node 的钉版（package.json）
server/     网关：鉴权、额度、计费、账本、支付、模型代理
website/    官网（静态）
scripts/    构建、发布、部署、OSS 工具
docs/       全部文档，入口是 docs/README.md
```

模型流量的走向、四条不能碰的接缝、两个上游为什么协议不同：见 [docs/architecture.md](docs/architecture.md)。

## 文档怎么读

- 第一次接手：**[docs/README.md](docs/README.md)**（按任务导航）→ [architecture.md](docs/architecture.md) → [current-state.md](docs/current-state.md)
- 要动钱：先读 [docs/money/standard.md](docs/money/standard.md)
- 要发版：docs/release.md、docs/signing.md
- 参与协作的规则：[AGENTS.md](AGENTS.md)

## 隐私

诊断统计、会话标题、模型请求分别处理什么，见 [docs/privacy.md](docs/privacy.md)（与 <https://mareo.cn/privacy.html> 同步）。

## 第三方

打包进应用的运行时与依赖清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
