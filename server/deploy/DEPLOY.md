# 网关部署手册

完整内容已迁到 [`../../docs/gateway-deploy.md`](../../docs/gateway-deploy.md)
（阿里云前置、Docker、HTTPS、备份恢复、升级、日常运维、支付宝密钥、境外出口）。

这里保留同目录下的操作资产：

| 文件 | 用途 |
|---|---|
| `docker-compose.yml` | 容器定义（`env_file: .env`、`./secrets` 只读挂载、数据与备份卷） |
| `.env.example` | 全部环境变量与说明 |
| `nginx-gateway.conf.example` | nginx 站点配置（SSE 不缓冲、超时 3600s） |
| `backup.sh` | 每日在线备份（`VACUUM INTO`） |
| `stats-page.sh` | 生成三个运营页面（cron 每 15 分钟） |
| `egress-proxy/` | 境外出口：中继侧与网关侧的安装脚本 |

部署步骤见 docs 那份文档；**不要**在这里另写一份，避免两处过期不一致。
