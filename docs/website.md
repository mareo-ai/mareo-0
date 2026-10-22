# 官网

`website/` 是 Mareo 的官网（<https://mareo.cn>）：纯静态 HTML/CSS/JS，**无构建工具**，与桌面应用完全独立。

## 页面与文件

| 文件 | 作用 |
|---|---|
| `index.html` | 首页，中英文内容都写在同一份 HTML 里（`lang="zh-CN"` / `lang="en"` 成对） |
| `privacy.html` / `privacy-en.html` | 隐私说明中英文两版，**与 `docs/privacy.md` 必须同步** |
| `app.js` | 语言切换与记忆、读取下载清单、页标题与描述文案（`pageText`）、匿名浏览计数 |
| `motion.js` | 首屏 16 个装饰粒子；不可见时暂停，系统"减少动态效果"时关闭 |
| `styles.css` / `privacy.css` | 样式（无外部字体） |
| `assets/` | 图标、logo、真实产品截图 |
| `test.mjs` | 页面级测试，`node --test website/test.mjs` |

`README.md` 与 `test.mjs` 不部署。

## 它依赖两个外部事实

1. **下载清单** `updates/latest.json`（同域）：由发布流程生成，提供 `downloads.macos` / `downloads.windows`。
   清单不可用时回退到 `app.js` 的 `downloadFallback`；清单在但缺某平台时，该平台显示"待开放"。
2. **浏览计数** `https://api.svc.mareo.cn/site-view`：页面加载时发一次，只累计"按天按页面"的次数。
   不存 IP、不设 Cookie、不用设备标识；服务端只为防刷在内存里短暂处理来源地址，不落库。

> 因此官网的**两条链路**分别指向两个地方：清单来自发布流程写进网站目录的文件，计数打到网关。
> 排查"下载按钮没更新"先看清单，"访问数不对"先看网关的 `site_views`。

## 本地预览

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory website
# 打开 http://127.0.0.1:8080
```

直接双击 `index.html` 也能看，但下载与计数依赖 HTTP，验证这些时用上面的方式。

## 部署

**发布流程会自动同步**：打 tag 发版时 `scripts/deploy-site.mjs` 把 `website/` 镜像到服务器的
`/var/www/mareo-site/`，然后才写最新清单（先同步页面、后更新清单，避免"新页面读到旧清单"的空窗）。

只改文案、不想发版时：

```sh
ECS_HOST=root@114.55.15.112 MAREO_DEPLOY_KEY=~/.ssh/mareo-0.pem npm run deploy:site
npm run deploy:site -- --dry-run      # 只看会执行什么
```

脚本行为（改动前请先读 `scripts/deploy-site.mjs`）：

- `rsync -az --delete`，**排除 `updates/` 与 `downloads/`**——这两个目录由发布流程独占，网站同步不得删除或覆盖
- `--chmod=Fu=rw,Fgo=r`：否则本地 600 权限的文件会让 nginx 返回 403
- 同步后自动校验首页、`/privacy.html`、首屏大图都返回 200，失败即退出

## 发布前检查

- `node --test website/test.mjs` 通过
- 中英文桌面与手机首屏都能看到下载入口；真实安装包链接可下载
- 首页、`/privacy.html` 返回 200；清单里的版本与最新发布一致
- 隐私文案与实际行为一致（尤其：模型请求经网关转发、`Mareo-O-*` 会出境到 OpenAI）

## 维护约定

- 文案改 `index.html` 里成对的两种语言；页标题/描述在 `app.js` 的 `pageText`，要和 HTML 里的默认中文元信息一致。
- 下载入口用 `data-download` 标平台，待开放用 `data-pending`，由同一次清单读取统一更新——**不要直接改按钮里的链接**。
- 保留隐私说明、联系方式与备案信息；"免费"只能表述为当前免费，不承诺永久。
- 署名保留 `Built on DeepSeek Harness`，明确 Mareo 是独立产品。
