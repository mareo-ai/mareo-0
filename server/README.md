# Mareo gateway

网关的完整说明已收进 `docs/`，这里只留入口：

| 想了解 | 去哪 |
|---|---|
| 路由、模型代理、表结构、计费、额度、支付 | [`../docs/gateway.md`](../docs/gateway.md) |
| 部署到服务器、境外出口（OpenAI 隧道）、备份与升级 | [`../docs/gateway-deploy.md`](../docs/gateway-deploy.md) |
| 钱的口径（单位、倍率、扣减顺序、账本、报表定义） | [`../docs/money/standard.md`](../docs/money/standard.md) |

## 本地跑（最短路径）

```sh
cd server
npm install
cp .env.example .env      # 填 DEEPSEEK_API_KEY
npm start                 # http://127.0.0.1:3000
npm run issue-token -- Alice
npm test
```
