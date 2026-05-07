# follow-builders-actions

每天北京时间 7:00 自动拉取 AI Builder 动态，用 Claude 生成中文摘要，推送到企业微信群。

基于 [follow-builders](https://github.com/zarazhangrui/follow-builders) 的数据源。

## 配置

在仓库 **Settings → Secrets and variables → Actions** 中添加两个 Secret：

| Secret 名称 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API Key，在 [console.anthropic.com](https://console.anthropic.com) 获取 |
| `WECOM_WEBHOOK_URL` | 企微群机器人 Webhook URL |

## 手动触发

在 GitHub Actions 页面点击 **Run workflow** 可立即触发一次。
