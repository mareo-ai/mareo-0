# Windows 构建与发布

Windows 产物是 **Squirrel 安装包**（`MareoSetup.exe`）。Squirrel 不能在 macOS 上交叉构建，因此必须在 Windows x64 上构建。两条路线：

- **方式 A（推荐，零本地环境）**：GitHub Actions 的 Windows runner 构建，产物作为 Artifact 下载
- **方式 B**：在一台 Windows 机器上按下面步骤本地构建

## 方式 A：GitHub Actions（无需本地 Windows）

1. 仓库 → **Actions** → 左侧 **Windows build** → **Run workflow** → 选择分支 → 运行
2. 约 10 分钟后，在该次运行页面底部 **Artifacts** 下载 `MareoSetup-windows-x64`
3. 解压得到 `MareoSetup.exe`，上传到服务器下载目录：
   ```sh
   scp MareoSetup.exe root@114.55.15.112:/var/www/mareo-site/downloads/
   ```
4. 更新官网 `website/app.js` 的 `downloads.windows` 为 `downloads/MareoSetup.exe`，rsync `index.html`/`app.js` 上线

**启用签名**（必需）：仓库 → Settings → Secrets and variables → Actions，添加三个 secret：

| Secret | 值 |
|---|---|
| `SSLTRUS_ACCESS_KEY` | 锐安信远程代码签名**订阅密钥**的 Access Key（控制台 → 代码签名证书 → 详情 → 安全） |
| `SSLTRUS_ACCESS_SECRET` | 同一个订阅的 Access Secret |
| `SSLTRUS_CERT_CODE` | 证书编号（`signtool quota --json` 的输出里能看到） |

签名走厂商云端 HSM，**没有 pfx、也不需要私钥文件**；细节见 [`signing.md`](signing.md) 的"Windows 云签名"一节。缺这三个 secret 时构建会**直接失败**，不会产出未签名安装包。

## 方式 B：本地 Windows 机器

## 前置

- Windows 10/11 x64
- Node.js 22+ 与 npm（`node --version` 可用即可）
- Git
- 锐安信远程代码签名凭据（`ACCESS_KEY`/`ACCESS_SECRET`/`SSLTRUS_CERT_CODE`）——没有凭据也能构建，但安装包未签名，用户会遇到 SmartScreen 警告（**发布流程不允许未签名**，CI 会拦）

## 一、代码与依赖

```powershell
git clone git@github.com:mareo-ai/mareo-0.git
cd mareo-0
git checkout main          # 或待验证的任务分支
npm install
```

## 二、验证运行时归档（首次会下载 Node）

```powershell
npm run check:node:win
# 期望：Verified win32/x64 Node 24.20.0 archive and layout.
```

这一步校验 `runtime/package.json` 里钉死的 Node 版本与 SHA-256，并确认解压后 `bin\node.exe` 存在。

## 三、签名环境变量（正式发布必做）

```powershell
# 从 sslTrus 客户端发布页装好 CLI（或直接用 CI 的安装脚本），然后：
$env:SSLTRUS_SIGNTOOL = "C:\tools\ssltrus\signtool.exe"   # 显式路径，避免和微软自带 signtool 撞名
$env:ACCESS_KEY = "<订阅 Access Key>"
$env:ACCESS_SECRET = "<订阅 Access Secret>"
$env:SSLTRUS_CERT_CODE = "<证书编号>"
```

> 未设置这些变量时仍会构建，只是产物未签名（构建日志会打一行 warning）；**发布流程不允许未签名**，CI 会先失败。
> 签名只覆盖 `Mareo.exe` 与 `MareoSetup.exe`，其余文件保留厂商自带签名——原因见 [`signing.md`](signing.md)。

## 四、构建

```powershell
npm run make:win
```

流程 = `build`（TypeScript）→ `stage:runtime:win`（装 DSH 依赖树 + Windows Node 运行时 + 生成品牌插件）→ `electron-forge make --platform win32 --arch=x64`。

产物：

```text
out\make\squirrel.windows\x64\MareoSetup.exe   ← 对外发布的就是它
out\Mareo-win32-x64\Mareo.exe                  ← 免安装可执行（调试用）
```

## 五、本机验证（发版前必做）

1. 双击 `MareoSetup.exe` 安装 → 开始菜单出现 Mareo
2. 打开 Mareo → 邮箱验证码登录（`https://api.svc.mareo.cn`）
3. 对话一次，确认网关记录到用量
4. 设置 → **账户**：显示邮箱、可改名、可退出登录
5. 退出后换另一个账号登录 → 会话/设置是独立环境
6. 控制面板卸载干净；再次安装覆盖升级正常

## 安装器行为（Squirrel）

- **快捷方式由应用自己创建**：Squirrel 安装/升级时会用 `--squirrel-install` / `--squirrel-updated` 启动应用，`src/squirrel.ts` + `src/main.ts` 收到后用 `Update.exe --createShortcut` 创建开始菜单与桌面快捷方式，然后立即退出。**若缺少这段处理，安装期间会误弹登录窗，且不会生成任何快捷方式**（旧版本正是如此）。
- 卸载时 Squirrel 传 `--squirrel-uninstall`，应用调用 `--removeShortcut` 清理。
- 安装期间的 loading 动画来自 `assets/installer-loading.gif`：320×240 圆角浅色卡片、透明四角、Mareo 标识和中文安装提示，三个小圆点按 1.8 秒周期平缓循环。这是忙碌指示，不代表实际安装百分比。
- GIF 已提交，Windows CI 直接使用，无需 Python 或字体。重新生成需要 Pillow 及包含中文字形的字体，例如在 macOS 执行：`python3 scripts/generate-installer-gif.py --font "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"`；Windows 可指定本机的微软雅黑字体文件。字体只用于本地栅格化，不打包字体文件。
- 资源验证：`python3 -B -m unittest discover -s tests -p 'test_installer_gif.py'`。发布前还需在 Windows 上实际安装，检查浅色／深色桌面、100%／150%／200% 缩放下的圆角透明、文字和动画，以及安装结束后窗口正常消失。GIF 不支持半透明阴影；本设计不模拟原生模糊阴影。
- “应用和功能”里的图标来自 `iconUrl`（`https://mareo.cn/downloads/app-icon.ico`）——**发布新版本前确认该文件已上传且可访问**。
- 快捷方式缺失时的补救：`& "$env:LOCALAPPDATA\Mareo\Update.exe" --createShortcut Mareo.exe`

## 六、上传与发布

```powershell
# 上传到官网下载目录（与 macOS 的 DMG 并列）
scp out\make\squirrel.windows\x64\MareoSetup.exe root@114.55.15.112:/var/www/mareo-site/downloads/
```

然后更新官网 `website/app.js` 里的 Windows 下载文件名（版本变化时），提交并同步：

```sh
rsync -az -e "ssh -i ~/.ssh/mareo-0.pem" website/index.html website/app.js root@114.55.15.112:/var/www/mareo-site/
```

## 常见问题

| 现象 | 处理 |
|---|---|
| `maker-squirrel` 报错需要 Windows | 属预期：Squirrel 不支持在 macOS/Linux 上构建，请在 Windows 执行 |
| 用户安装时出现"Windows 已保护你的电脑" | 安装包未签名，或新证书尚未积累信誉（EV 证书可立即通过；OV 需一段时间） |
| 图标不是 Mareo | 确认 `assets/app-icon.ico` 已提交；改图标后在 macOS 上跑 `npm run generate:ico` |
| 杀软误报 | 未签名安装包的常见现象，签名后可显著缓解 |
| DSH 无法启动 | 查看 `%APPDATA%\Mareo\logs\mareo.log`；确认 Node 运行时已随包（`Resources\node-runtime\bin\node.exe`） |

## 已知限制（当前版本）

- 仅支持 Windows x64
- 暂无自动更新（后续可接入 Squirrel 更新源）
- 无 MSI / 免安装 ZIP 之外的形态
