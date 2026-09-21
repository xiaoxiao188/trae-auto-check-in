# trae-checkin (Cloudflare Worker)

Trae 每日积分自动签到，部署在 Cloudflare Workers 上，每天定时自动执行，电脑关机不影响。
签到结果支持推送到**钉钉 / 飞书**群机器人。

## 功能特性

- 🕐 每天定时自动签到（Cron Trigger，默认北京时间 08:30）
- 👥 多账号支持（`TRAE_SESSION_2`、`TRAE_SESSION_3`……）
- 🛡️ 命中 9074「参与用户太多」风控时自动换设备号重试（最多 5 次）
- 📢 签到结果推送到钉钉（markdown 消息，支持加签）/ 飞书群机器人，可同时推送；含签到积分和通用积分（剩余额度）
- 🖱️ 浏览器访问 Worker URL 可手动触发一次，页面直接显示签到结果和推送诊断
- 🚫 自动忽略 `/favicon.ico` 等浏览器附加请求，不会重复签到推送

## 原理

移植自 [TraeTools](https://github.com/star620/TraeTools) 的 `checkin.py`：
用 `X-Cloudide-Session` Cookie 调用 `GetUserToken` 换取新 JWT，再调用签到接口。
全程仅 HTTP 请求，非常适合 Cloudflare Workers（免费额度完全够用）。

## 项目结构

```
trae-checkin/
├── src/index.js      # Worker 主代码（签到 + 推送）
├── wrangler.toml     # 定时配置 + 明文变量
├── secrets.json      # 密钥批量导入模板（勿提交 Git）
└── package.json
```

## 部署（三步）

```powershell
cd D:\projects\cline\trae-checkin
npm install
npx wrangler login        # ① 首次使用：弹浏览器点 Allow 授权
npx wrangler deploy       # ② 部署代码 + 定时配置
```

③ 导入密钥：编辑 `secrets.json` 填入真实值，然后一条命令批量导入：

```powershell
npx wrangler secret bulk secrets.json
```

> 也可以逐个添加：`npx wrangler secret put TRAE_SESSION`（粘贴值后回车），
> 或在网页控制台「设置 → 变量和机密」中添加（类型选**机密**）。

## 配置项

### 密钥（Secrets，敏感信息，用 `secret bulk` / 控制台添加）

| Secret | 必填 | 说明 |
|---|---|---|
| `TRAE_SESSION` | ✅ | 账号 1 的 `X-Cloudide-Session` Cookie |
| `TRAE_DEVICE_ID` | | 16 位数字设备号，缺省随机生成 |
| `TRAE_SESSION_2` / `TRAE_DEVICE_ID_2` … | | 第 2、3… 个账号 |
| `DINGTALK_WEBHOOK` | | 钉钉群机器人 Webhook 地址 |
| `DINGTALK_SECRET` | | 钉钉机器人开启"加签"时的 `SEC` 开头密钥 |
| `FEISHU_WEBHOOK` | | 飞书机器人 Webhook |

飞书和钉钉可以同时配置，会同时推送；都不配置则只在页面/日志输出结果。

⚠️ **不要把密钥写进 `wrangler.toml`**，那里是明文的，会泄露账号凭证。

## 获取 TRAE_SESSION

浏览器登录 <https://www.trae.cn> → F12 → Application（应用）→ Cookies → 复制 `X-Cloudide-Session` 的值。

有效期约 **14 天**，过期后更新 `secrets.json` 再跑一次 `npx wrangler secret bulk secrets.json` 即可（无需重新部署）。

## 配置钉钉机器人

1. 钉钉群里：群设置 → 机器人 → 添加机器人 → **自定义**；
2. 安全设置三选一：
   - **自定义关键词**：填 `Trae`（推送内容以 "Trae 签到结果" 开头，天然满足），最简单；
   - **加签**：复制 `SEC...` 开头的密钥，配到 `DINGTALK_SECRET`；
   - IP 地址段：不推荐（Worker 出口 IP 不固定）；
3. 复制 Webhook 地址（`https://oapi.dingtalk.com/robot/send?access_token=...`），配到 `DINGTALK_WEBHOOK`。

## 推送消息示例

钉钉以 **markdown 消息**推送，标题 `Trae 自动签到` 为加粗四级标题样式，下方带 `---` 分割线：

```
Trae 自动签到
帐号：账号 1
签到结果：✅ 成功
签到积分：+200
通用积分：2525.49
时间：2026-09-21 08:30:05
```

> 签到积分 = 本次签到获得的积分（`checkin_credits/status` 的基础分 + 额外分）；
> 通用积分 = 通用积分包（TraeCode / TraeWork 均可用）的剩余额度之和，
> 来自 `/trae/api/v2/pay/web_user_ent_usage` 中 `available_endpoint = 0` 的积分包（不含 Work 专属积分）；
> 多账号时每个账号一段，失败账号显示 `❌ 失败（原因）`。

## 测试

- **手动触发**：访问 Worker 的 URL（`https://trae-checkin.<你的子域>.workers.dev`），
  页面显示签到结果，底部 `---` 之后是推送诊断（钉钉接口返回的 errcode）；
- **本地模拟定时**：`npx wrangler dev --test-scheduled`，然后访问 `http://localhost:8787/__scheduled`；
- **查看日志**：`npx wrangler tail`，或控制台 → Workers → trae-checkin → 日志。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 钉钉返回 `errcode:0` 但群里没消息 | 检查是否进错群；机器人是否被停用 |
| `sign not match` | 加签密钥不对，重新复制完整 `SEC` 开头密钥（别带空格）更新 `DINGTALK_SECRET` |
| `keywords not in content` | 机器人设了关键词但消息没包含，把关键词改成 `Trae` |
| 每次推送两条 | 旧版本被 `/favicon.ico` 重复触发，更新代码重新部署即可；另检查控制台「触发器」是否有重复的 Cron |
| `签到积分：+0` | 当天已签过，重复签到不加分，属正常 |
| 签到失败 `会话已失效(401)` | Session 过期（约 14 天），重新抓 Cookie 并更新 `TRAE_SESSION` |
| 签到失败 `9074 参与用户太多` | 风控，脚本已自动换设备号重试；仍失败可把 cron 调到冷门时段（如北京凌晨） |

## 日常维护

- **改了代码 / 定时时间** → `npx wrangler deploy`；
- **只改了密钥**（如 Session 过期更新）→ 改 `secrets.json` 后 `npx wrangler secret bulk secrets.json`，无需部署；
- 建议导入密钥后清空 `secrets.json` 中的真实值（已在 `.gitignore` 中排除，不会误提交）。

## 修改签到时间

编辑 `wrangler.toml`：

```toml
[triggers]
crons = ["30 0 * * *"]   # UTC 时间，北京时间 = UTC+8
```

改完 `npx wrangler deploy` 生效。

## 免责声明

本项目与 ByteDance / Trae 官方无任何关系。签到接口为逆向的非公开接口，字段可能随官方更新变化；
使用自动签到请遵守 Trae 服务条款，风险自负。账号凭证仅保存在你自己的 Cloudflare 账号中。

