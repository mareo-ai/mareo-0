# Mareo 代码签名（macOS 公证 + Windows 云签名）

让官网下载的安装包在普通用户机器上**不再被 Gatekeeper / SmartScreen 拦下**。只影响打包环节，不影响代码与运行时。

- macOS：用 Apple **Developer ID** 证书签名 + Notarytool 公证（下文第一、二节）。
- Windows：用**锐安信（sslTrus）云签名**——证书不含 UKey，私钥在厂商 HSM 里，签名通过他们的 CLI 完成（见"Windows 云签名"一节）。

## 前置（一次性，Apple 侧）

1. **证书**：钥匙串里必须有 **Developer ID Application** 证书。验证：
   ```sh
   security find-identity -v -p codesigning | grep "Developer ID Application"
   # 期望输出：1) <HASH> "Developer ID Application: 你的名字 (TEAMID)"
   ```
   没有的话：Xcode → Settings → Accounts → 登录 Apple ID → Manage Certificates → **+** → Developer ID Application（会立即装进钥匙串）。
   > 注意："Apple Development" 证书不能用于对外分发，且**不要**让它被自动选中。

2. **Team ID**：developer.apple.com → Membership（本项目：`Q85U66X3JF`）。

3. **App 专用密码**：`appleid.apple.com` → 登录与安全 → App 专用密码 → 生成（如 `Mareo Notary`），得到 `xxxx-xxxx-xxxx-xxxx`。它只用于公证上传，别发给别人、别写进仓库。

## 执行

```sh
# 证书名可省略（脚本会自动找 Developer ID Application）；有多个时可显式指定：
export CSC_NAME="Developer ID Application: 你的名字 (Q85U66X3JF)"

# 公证三件套（都设了才会公证；不设则只签名/或都跳过）
export APPLE_ID="你的AppleID邮箱"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="Q85U66X3JF"

# 你的网络拉 Electron 需要镜像（否则打包会超时）
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

npm run make
```

脚本行为（`scripts/sign-macos.mjs`，挂在 forge `postPackage` hook）：
- 找到 Developer ID 证书 → **签名**（hardened runtime + `entitlements.mac.plist`）；
- 三件套齐全 → **公证**（notarytool `--wait`）并 **staple**；
- 两者任一缺失 → 打印跳过提示，退回未签名打包（开发流程不受影响）。

## 验证

```sh
APP=out/Mareo-darwin-arm64/Mareo.app
codesign --verify --deep --strict "$APP" && echo "签名有效"
xcrun stapler validate "$APP" && echo "公证已附带"
spctl -a -t exec -vv "$APP"            # 期望: accepted, source=Notarized Developer ID
```

## Windows 云签名（锐安信 sslTrus，无 UKey）

**买的是什么**：DigiCert 普通（OV）代码签名证书 + **远程代码签名服务**订阅（按签名次数计费，¥500/年 = 1000 次）。证书"不含 UKey"意味着私钥生成并保存在厂商的 FIPS 140-3 云端 HSM 内、不可导出；本地只算文件哈希上传，签名在云端完成。所以**没有 pfx、也没有私钥落盘**。

**一次发版签哪些文件**：只有两个，都是我们自己的二进制。

| 文件 | 为什么必须签 |
|---|---|
| `Mareo.exe` | 打包时 `@electron/packager` 会改写它的图标与版本信息，**这会让 Electron 原本的签名失效**；"签名无效"比未签名更容易被系统刁难 |
| `MareoSetup.exe` | 用户从浏览器下载、第一次被 SmartScreen 检查的就是它，发布者名称与声誉挂在它身上 |

其余 PE 文件**不签**：`node.exe`（OpenJS Foundation）、`conpty.dll`/`OpenConsole.exe`（Microsoft）等本来就带有效厂商签名；而 Electron 的 `ffmpeg.dll`、`vk_swiftshader.dll` 等上游就没签，DSH 带进来的原生模块（`libvips`、`sharp`、`rg.exe`…）也没签。它们**不影响 SmartScreen**（它只看用户下载的那个安装包），而全部签下来一次构建要 20–40 次、一年 1000 次的额度几次发版就烧光。hook 里的白名单在 `scripts/sign-windows.cjs` 的 `isMareoArtifact`。

**签名怎么接进构建**（两个时点）：

1. **打包阶段**：`forge.config.cjs` 的 `packagerConfig.windowsSign` 指向 hook，`@electron/windows-sign` 会为 app 目录里每个 PE 文件回调一次，hook 只签 `Mareo.exe`（其余每个文件打一行 `skipping …` 日志）。发生在 Squirrel 打包**之前**，所以 nupkg 里装出来的也是签名版本。
2. **`postMake`**：签 Squirrel 产出的 `MareoSetup.exe`，**然后**才复制出版本化副本（复制保留签名，所以两个名字都是签好的）。

> ⚠️ `@electron/packager` 会**吞掉**签名失败（debug 后继续打包）。所以 CI 里的 `scripts/verify-windows-signatures.ps1` 才是真正的守门人：它断言这两个文件 `Status = Valid` **且签名者指纹等于下面这枚证书**，并把 app 目录里其它 PE 文件的签名状态打印出来。

**在用证书（2026-10 首发）**：主体 `CN=武汉市大头人工智能科技有限公司, O=…, L=武汉市, S=湖北省, C=CN`；SHA-1 指纹（`Get-AuthenticodeSignature` 的 Thumbprint）**`24F773B0CEC1D43AD42752B2050E0105A901F7DD`**。校验脚本里硬编码了这个值——**换证/续期后必须同步更新**，否则 CI 会明确报错（这是故意的，避免错误的证书静默通过）。

**2026-10-12 首次签名构建的实测（`windows-build` 运行 38268197511）**：

- 两个目标 `Valid`，签名者指纹就是上面那枚；**一次构建消耗 2 次签名**（控制台"已签名次数 2"），1000 次/年 ≈ 500 次构建。
- 盘点结论（修正了"Electron 的 dll 全都带厂商签名"这个想当然）：
  - **带有效厂商签名**：`node.exe`（OpenJS Foundation）、`conpty.dll`/`OpenConsole.exe`（Microsoft）、`d3dcompiler_47.dll`/`dxil.dll`（Microsoft Windows）。
  - **未签名**：Electron 的 `ffmpeg.dll`、`vk_swiftshader.dll`、`vulkan-1.dll`、`dxcompiler.dll`，以及 DSH 带进来的原生模块（`libvips-*.dll`、`sharp-*.node`、`koffi.node`、`rg.exe`、`conpty.node` 等）。
  - 这些**不影响 SmartScreen**（它只看用户下载的那个安装包），而按全量签名的话一次构建要 20–40 次、一年额度几次发版就烧光，所以维持"只签两个"。
  - 若将来某个本来 `Valid` 的文件变成 `NotSigned`，说明上游换了打包方式，值得查。

**CI 需要的三个 secret**：`SSLTRUS_ACCESS_KEY`、`SSLTRUS_ACCESS_SECRET`、`SSLTRUS_CERT_CODE`。前两个建议用**订阅密钥**（控制台 → 代码签名证书 → 详情 → 安全 → Access Key → 创建凭证，权限只覆盖这一张证书）。

**证书编号（Cert Code）怎么拿**：`SSLTRUS_CERT_CODE` 就是他们 CLI 的 `--cert-code`，指"用哪张证书签名"。权威拿法是配置好 AK/SK 后跑一次：

```sh
export ACCESS_KEY=... ACCESS_SECRET=...
signtool quota --json      # 输出里含"证书编号"与剩余次数
```

**本地验证（不消耗签名次数）**：CLI 有 `--dry-run`，可以先把调用链走通；`signtool quota` 只查询、不计次。CLI 下载页 <https://pccs.ssltrus.cn/oss-code-sign-client/index.html>，版本索引 `latest.json`（安装脚本会校验 sha256）。

**排障**：

| 现象 | 原因/处理 |
|---|---|
| 构建报 `Windows signing needs ACCESS_KEY…` | 三个 secret 没配齐；release 构建**必须**有签名，不要改成"跳过" |
| `status = UnknownError` 或仍提示"文件已被修改" | 打包后的 exe 带着失效的旧签名；hook 已用 `--nest=false` 先清掉再签，若仍复现检查该参数 |
| 签名次数不够 | 在控制台查额度；我们每次构建只消耗 2 次左右 |
| 换证书/续期 | 主体保持一致可延续 SmartScreen 声誉；换证后 CI 依据 `Status = Valid` 会自动通过，如需额外核对主体，把 `verify-windows-signatures.ps1` 打印的 thumbprint 记进本文件 |

**关于 SmartScreen 的预期**：OV 证书**不会立刻消除**"Windows 已保护你的电脑"，新证书声誉要从零积累（通常几百到几千次安装），期间用户仍会看到提示但能看到发布者名称；只有 EV 才可能立即免警告。

## 发布

把签名 DMG 上传服务器替换 `downloads/` 下旧文件，并把官网"未签名内测版"提示改为正式版说明（改 `website/index.html` 文案 + 重新 rsync）。

## 常见问题

| 问题 | 处理 |
|---|---|
| 提示无 Developer ID 证书 | 按上文在 **这台 Mac** 用 Xcode 生成；`security find-identity` 应能看到 |
| 公证报错 invalid | 确认 `APPLE_APP_SPECIFIC_PASSWORD` 是 App 专用密码（不是登录密码）且账号是开发者账号本人 |
| `npm run make` 拉 Electron 超时 | 记得 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| 只想快速出个未签名包 | macOS：不设任何签名环境变量直接 `npm run make`；Windows 的 `make:win` 在缺签名凭据时会打一行 warning 并产出未签名包（**发布流程不允许**，CI 会先失败） |

## 一键发布

`npm run release`（`scripts/release.mjs`）负责**发版本身**：改版本号 → 提交并推送 main → 打 tag。构建、签名、公证、上传 OSS、更新官网清单全部由 CI 完成，本地不需要证书或服务器配置。

```sh
npm run release                 # 交互式：推荐版本号（可改）→ 更新说明 → minimumVersion（留空 = 不强制）→ 确认
npm run release -- --dry-run    # 只打印计划，不做任何改动
```

非交互用法（四项都要给全，用于脚本化）：

```sh
npm run release -- --version 0.1.3 --notes "修复账户隔离问题" --minimum-version "" --yes
```

脚本会先做安全检查：必须在 `main` 上、工作区干净、本地不落后远端、版本号未重复；任一项不满足就直接退出。推送 tag 后到 [Actions](https://github.com/mareo-ai/mareo-0/actions/workflows/release.yml) 看进度，约 20–40 分钟（含 Apple 公证）。

签名、公证、OSS 上传所需的一切都在 GitHub Secrets 与 Variables 里，见 [`release.md`](release.md)。

