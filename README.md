# trae-checkin (Cloudflare Worker)

Trae 每日积分自动签到，部署在 Cloudflare Workers 上，每天定时自动执行，电脑关机不影响。
签到结果支持推送到**钉钉 / 飞书**群机器人。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xiaoxiao188/trae-auto-check-in)

**不想装任何环境？** 点上面按钮，浏览器里 2 分钟部署到你自己的 Cloudflare 账号，
步骤见下文[一键部署](#一键部署免环境浏览器里-2-分钟)。
本机装有 Trae 客户端的同学推荐[本地部署](#本地部署完整功能含自动续期)，
可启用约半年免维护的自动续期模式。

## 功能特性

- 🔑 **自动续期模式（推荐）**：从本机 Trae 客户端一键提取 RefreshToken（约半年有效），Worker 每天自动换新 JWT，无需再抓 Cookie；到期前推送提醒
- 🕐 每天定时自动签到（Cron Trigger，默认北京时间 10:05，部署时可修改）
- 👥 多账号支持（`TRAE_SESSION_2`、`TRAE_SESSION_3`……），编号不连续（如漏配 `_2`）时推送中会提示，避免悄悄漏配
- 🪪 推送显示真实账号：自动拉取昵称 + 脱敏手机号（如 `张三 138****1234`），拿不到时回退「账号 N」
- 🛡️ 命中 9074「参与用户太多」风控时自动换设备号重试（最多 5 次）
- 🔁 网络瞬断或上游 5xx 自动重试（最多 3 次、间隔递增），偶发抖动不致错过当日签到
- 📢 签到结果推送到钉钉（markdown 消息，支持加签）/ 飞书群机器人（**卡片消息**：成功绿 / 警告橙 / 失败红标题栏，✅❌ 着色），可同时推送；含签到积分和通用积分（剩余额度）
- ⏳ 凭证到期提醒：每天推送显示各账号的凭证剩余天数，临期 ⚠️ 高亮（续期凭证约半年一换，Cookie 会话约 13 天一换）
- 🖱️ 浏览器访问 Worker URL 可手动触发一次，页面直接显示签到结果和推送诊断；
  配置 `TRIGGER_KEY` 后需带 `?key=密钥` 访问（本地与云端都未配置时部署脚本自动生成）
- 🚫 自动忽略 `/favicon.ico` 等浏览器附加请求，不会重复签到推送

## 原理

移植自 [TraeTools](https://github.com/star620/TraeTools) 的 `checkin.py`，签到与续期接口逆向自 Trae 客户端（参考
[qilimixingkong/trae-checkin](https://github.com/qilimixingkong/trae-checkin)、[magpie#808](https://github.com/yetone/magpie/issues/808)）：

- **续期模式**：本机 Trae 客户端登录后，`npm run extract` 从其 `storage.json` 解密出 RefreshToken
  （约半年有效）和设备 ECDSA P-256 密钥对；Worker 每天用密钥对给
  `/trae/api/v3/oauth/ExchangeToken` 签名换新 JWT（绑定了设备，签到不触发 9074 风控）。
  实测该接口返回新 RefreshToken 但**不作废旧值**，不影响客户端自身登录态；
- **Cookie 模式**：用 `X-Cloudide-Session` Cookie 调 `GetUserToken` 换新 JWT（约 13 天过期，需手动更新）。

两种模式可共存：配了 RefreshToken 的账号优先用续期模式，失败自动回退 Cookie 模式。

## 项目结构

```
trae-checkin/
├── src/index.js      # Worker 主代码（签到 + 推送，两种凭证模式）
├── src/trae-auth.js  # 凭证续期核心（storage.json 解密 + ExchangeToken 签名）
├── wrangler.toml     # 定时配置 + 明文变量
├── secrets.json      # 密钥默认值（勿提交 Git）
├── deploy.mjs        # 交互式部署：逐项确认密钥与触发时间，回车沿用文件值
├── extract.mjs        # 从本机 Trae 客户端提取续期凭证写入 secrets.json
├── test/             # 单元测试（npm test）
└── package.json
```

## 一键部署（免环境，浏览器里 2 分钟）

适合不想装 Node / 命令行的同学：点 README 顶部的 **Deploy to Cloudflare Workers** 按钮，
登录你自己的 Cloudflare 账号（没有就注册一个，免费额度完全够用）→ 等待部署完成。

按钮部署的是代码和每日定时（默认北京时间 10:05），**签到凭证要你自己填**——
凭证是每个人自己 Trae 账号的登录态，任何「一键」都替代不了这一步（浏览器安全机制禁止
别的网页读取 trae.cn 的 Cookie，这是保护你账号的设计）。

### 按钮部署后要填什么（重点看这里）

填的位置都一样：**Cloudflare 控制台 → Workers & Pages → `trae-checkin` →
设置（Settings）→ 变量和机密（Variables and Secrets）→ 添加**，
类型选**机密（Secret）**，按下表逐个添加：

| 顺序 | 变量名 | 必填吗 | 干什么用 | 值从哪来 |
|---|---|---|---|---|
| ① | `TRAE_SESSION` | **✅ 必填** | 你的 Trae 登录凭证，签到全靠它 | 登录 <https://www.trae.cn> 后从浏览器 Cookie 里复制 `X-Cloudide-Session` 的值，**点击看手把手教程**：[获取 TRAE_SESSION](#获取-trae_session手把手教程) |
| ② | `DINGTALK_WEBHOOK` | 可选 | 签到结果推送到**钉钉群** | 钉钉群 → 群设置 → 机器人 → 添加「自定义」→ 安全设置选**自定义关键词**填 `Trae`（最简单）→ 复制 Webhook 地址，详见下文「配置钉钉机器人」 |
| ③ | `DINGTALK_SECRET` | 可选 | 钉钉机器人安全设置选了「**加签**」时才需要 | 同上一步，复制 `SEC` 开头的加签密钥 |
| ④ | `FEISHU_WEBHOOK` | 可选 | 签到结果推送到**飞书群** | 飞书群机器人 Webhook 地址 |
| ⑤ | `TRIGGER_KEY` | 建议配 | 手动触发网址的「密码」，防止 URL 泄露后被他人触发、看到你的账号信息 | 随便一串复杂字符（在线生成个 UUID 即可），之后访问需带 `?key=此值` |

填完 ① 立即生效：第二天开始每天自动签到。**想立刻验证**：访问
`https://trae-checkin.<你的子域>.workers.dev`（配了 ⑤ 时加 `?key=密钥`），
页面会直接显示一次签到结果。

一键部署的说明与限制：

- 走 **Cookie 模式**：会话约 13 天过期，届时重新登录 trae.cn 抓一次 Cookie，
  回到控制台**同一位置**粘贴更新即可（每天推送会提前 ⚠️ 提醒剩余天数）；
- 想要「约半年不用管」的自动续期模式，需本机装有 Trae 客户端，请用下面的本地部署；
- 不配置 `TRIGGER_KEY` 时，手动触发地址没有鉴权（URL 只有你自己知道，介意就配上）；
- 推送一条都不配也行，结果只在手动访问网址时显示。

## 本地部署（完整功能，含自动续期）

```powershell
git clone https://github.com/xiaoxiao188/trae-auto-check-in.git
cd trae-auto-check-in
npm install
npx wrangler login        # ① 首次使用：弹浏览器点 Allow 授权
npm run deploy            # ② 自动提取续期凭证 + 交互式部署（确认密钥与触发时间）
```

`npm run deploy` 部署前会**自动从本机 Trae 客户端提取续期凭证**（检测到已登录客户端才执行，
验证可用后随部署一并上传；没有客户端则跳过，Cookie 模式不受影响），因此每次部署都会
自动保鲜 RefreshToken——**约半年一次的凭证更新同样只需 `npm run deploy` 这一条命令**。

`npm run deploy` 会逐项询问各密钥和定时触发时间：

- **直接回车** = 沿用文件中的现有值（密钥来自 `secrets.json`，触发时间来自 `wrangler.toml`）；
- **输入新值** = 本次部署使用新值，并写回对应文件作为下次默认；触发时间输入北京时间
  `HH:MM`（如 `08:30`，自动换算为 UTC cron），也可直接输入 5 段 UTC cron 表达式；
- `TRIGGER_KEY` 例外：本地与云端都未配置时，直接回车 = **自动生成随机密钥**并上传；
  已配置（文件或云端）则沿用，不会覆盖；
- 全部输入后有一行**汇总确认**（回车=开始部署，n=取消），取消则不写文件、不部署；
- 确认后依次执行 `wrangler deploy`（同步代码与 cron 触发时间）和
  `wrangler secret bulk secrets.json`（上传密钥）；CI 等无输入环境自动沿用文件值，不会卡住；
- 部署完成后会**自动触发一次签到**（本地运行同款签到逻辑，不依赖 workers.dev 域名），终端直接显示签到结果；

> 也可以逐个添加：`npx wrangler secret put TRAE_SESSION`（粘贴值后回车），
> 或在网页控制台「设置 → 变量和机密」中添加（类型选**机密**）。

## 配置项

### 密钥（Secrets，敏感信息，用 `secret bulk` / 控制台添加）

| Secret | 必填 | 说明 |
|---|---|---|
| `TRAE_REFRESH_TOKEN` | ✅ | 账号 1 的 RefreshToken（`npm run extract` 自动写入，约半年有效） |
| `TRAE_DEVICE` | ✅ | 设备密钥对与指纹 JSON（`npm run extract` 自动写入，机器级各账号共用） |
| `TRAE_SESSION` | | 账号 1 的 `X-Cloudide-Session` Cookie（Cookie 模式 / 续期失败兜底） |
| `TRAE_DEVICE_ID` | | 16 位数字设备号，缺省随机生成 |
| `TRAE_REFRESH_TOKEN_2` / `TRAE_SESSION_2` … | | 第 2、3… 个账号（两种模式按编号对应） |
| `TRAE_REFRESH_EXPIRY` / `TRAE_SESSION_DATE` … | | 对应凭证的到期/更新日期，提取/部署时自动记录，用于剩余天数提醒 |
| `TRAE_REFRESH_LABEL` … | | 续期模式的账号展示名（提取时记录的昵称 + 脱敏手机号） |
| `DINGTALK_WEBHOOK` | | 钉钉群机器人 Webhook 地址 |
| `DINGTALK_SECRET` | | 钉钉机器人开启"加签"时的 `SEC` 开头密钥 |
| `FEISHU_WEBHOOK` | | 飞书机器人 Webhook |
| `TRIGGER_KEY` | | 手动触发密钥：访问 Worker URL 需带 `?key=<值>`；本地与云端都未配置时部署自动生成，已有则沿用不覆盖 |

飞书和钉钉可以同时配置，会同时推送；都不配置则只在页面/日志输出结果。

⚠️ **不要把密钥写进 `wrangler.toml`**，那里是明文的，会泄露账号凭证。

## 启用自动续期（推荐，一次管半年）

前提：本机装了 **Trae CN / TRAE SOLO CN** 客户端并登录了要签到的账号。然后正常
`npm run deploy` 即可——部署脚本自动完成提取、验证、上传，无需任何额外步骤。

自动提取做了什么：解密客户端 `storage.json` → 取出 RefreshToken（约半年有效）和设备
ECDSA 密钥对 → 真实调用一次 ExchangeToken 验证（该接口不轮换不作废旧值，不影响客户端
登录态）→ 写入 `secrets.json` 的 `TRAE_DEVICE` / `TRAE_REFRESH_TOKEN` /
`TRAE_REFRESH_EXPIRY` / `TRAE_REFRESH_LABEL` 并随部署上传。

推送中会显示「凭证模式：自动续期（约剩 N 天）」，剩 14 天内 ⚠️ 提醒刷新；刷新 = 在客户端
登录该账号后重跑 `npm run deploy`（一条命令完成）。

需要单独操作时（不部署）：

- `npm run extract`：只提取写入 `secrets.json` 不部署（之后 `npm run secrets` 上传）；
- `npm run extract -- --account 2`：写入其他账号编号（部署自动提取固定写账号 1）。

注意事项：

- RefreshToken 与客户端登录态同源：在客户端里**切换到其他账号会吊销已提取的凭证**
  （社区实测），切换后需重新登录原账号再 `npm run extract`；
- 凭证过期后若配置了同编号的 `TRAE_SESSION`，会自动回退 Cookie 模式继续签到，不会漏签；
- 仅支持 Windows（读取 `%APPDATA%` 下客户端数据）；解密算法随客户端更新可能失效
  （报「密文头部不符合预期」时需重新逆向）。

## 获取 TRAE_SESSION（手把手教程）

`TRAE_SESSION` 就是 `X-Cloudide-Session` 这个 Cookie——你在 trae.cn 网站的「登录凭证」。
在**电脑**上用 Chrome 或 Edge 操作（手机浏览器没有开发者工具，不行）：

1. 打开 <https://www.trae.cn> 并**登录**（手机号 + 验证码；已登录可跳过这一步）；
2. 按键盘 **F12** 调出开发者工具（部分笔记本要按 `Fn + F12`；
   或者换个姿势：在页面空白处**右键 → 检查 / Inspect**）；
3. 点工具栏顶部的 **Application（应用）** 标签——看不到时点标签栏的 `>>` 展开更多；
4. 左侧找到 **Storage（存储）→ Cookies**，点它下面的 `https://www.trae.cn`；
5. 右侧的 Cookie 列表里，按 **Name（名称）** 列找到 `X-Cloudide-Session` 这一行；
6. 双击这一行的 **Value（值）** → `Ctrl + A` 全选 → `Ctrl + C` 复制。
   这是一长串字符（结尾形如 `.18dcce0e…`），**必须复制完整**，前后不能带空格或换行；
7. 粘贴到 `TRAE_SESSION` 的值里：一键部署用户粘到 Cloudflare 控制台，
   本地部署用户在 `npm run deploy` 的「Trae 登录凭证」提示处粘贴。

常见卡点：

| 现象 | 解决 |
|---|---|
| 找不到 Application 标签 | 点开发者工具顶部标签栏的 `>>` 符号展开 |
| Cookies 列表里没有 `X-Cloudide-Session` | 先确认 trae.cn 已登录成功，刷新页面再找 |
| 复制后签到报 `会话已失效(401)` | 值没复制完整 / 带了空格换行，重新完整复制 |
| 只有一列 Cookie 名看不懂 | Name 是名字、Value 才是要复制的值，别复制错列 |

有效期约 **13~14 天**（从登录时算起），到期后重走一遍上面的步骤换新值即可——每天的推送会
提前 ⚠️ 提醒剩余天数，不会突然失效才发现。本地部署用户建议优先用[自动续期模式](#启用自动续期推荐一次管半年)
（约半年免更新），仅在无法使用时（非 Windows、客户端解密失效）才走 Cookie 模式。

## 配置钉钉机器人

1. 钉钉群里：群设置 → 机器人 → 添加机器人 → **自定义**；
2. 安全设置三选一：
   - **自定义关键词**：填 `Trae`（推送内容以 "Trae 签到结果" 开头，天然满足），最简单；
   - **加签**：复制 `SEC...` 开头的密钥，配到 `DINGTALK_SECRET`；
   - IP 地址段：不推荐（Worker 出口 IP 不固定）；
3. 复制 Webhook 地址（`https://oapi.dingtalk.com/robot/send?access_token=...`），配到 `DINGTALK_WEBHOOK`。

## 推送消息示例

钉钉以 **markdown 消息**推送，标题 `Trae 自动签到` 为加粗四级标题样式，下方带 `---` 分割线；
飞书以**卡片消息**推送（同样排版，且标题栏按结果变色：全部成功**绿色**、有临期/漏配警告**橙色**、
有失败**红色**，✅ 绿字 / ❌ 红字，时间为底部灰色小字）：

```
Trae 自动签到
账号：张三 138****1234
签到结果：✅ 成功
签到积分：+150
通用积分：4825.49
Work 专属积分：0
总可用积分：4825.49
凭证模式：自动续期（约剩 170 天）
签到时间：2026-10-13 10:05:05
```

> 账号名：续期模式取自提取时记录的昵称 + 官方脱敏手机号；Cookie 模式来自
> `/cloudide/api/v3/trae/GetUserInfo`（该接口需要 Cookie，续期模式下不可用）。拉取失败
> 不影响签到，回退显示「账号 N」。

> 签到积分 = **本次签到实际入账**的积分（优先取 claim 返回值；claim 不带分时取当日「签到奖励」积分包额度。
> 每天首次执行前先查签到状态，已签过则跳过签到接口，显示 `+0（今日已签到）`）；
> 三类积分来自 `/trae/api/v2/pay/web_user_ent_usage` 的积分包（按 `available_endpoint` 分类）：
> **通用积分** = `endpoint 0` 包剩余之和（TraeCode / TraeWork 均可用）；
> **Work 专属积分** = `endpoint 1` 包剩余之和（仅 TraeWork 可用）；
> **总可用积分** = 所有可量化包的剩余之和（免费基础包 `free_xxx` 无额度上限，不计入）；
> 多账号时每个账号一段，失败账号显示 `❌ 失败（原因）`，并各自显示会话剩余天数。

## 测试

- **手动触发**：访问 Worker 的 URL（`https://trae-checkin.<你的子域>.workers.dev`，配置了
  `TRIGGER_KEY` 时加 `?key=<密钥>`），页面显示签到结果，底部 `---` 之后是推送诊断（钉钉/飞书接口返回）；
- **本地模拟定时**：`npx wrangler dev --test-scheduled`，然后访问 `http://localhost:8787/__scheduled`；
- **单元测试**：`npm test`（覆盖 deploy 的 cron 换算与交互逻辑、凭证解密与签名转换）；
- **查看日志**：`npx wrangler tail`，或控制台 → Workers → trae-checkin → 日志。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 钉钉返回 `errcode:0` 但群里没消息 | 检查是否进错群；机器人是否被停用 |
| `sign not match` | 加签密钥不对，重新复制完整 `SEC` 开头密钥（别带空格）更新 `DINGTALK_SECRET` |
| `keywords not in content` | 机器人设了关键词但消息没包含，把关键词改成 `Trae` |
| 每次推送两条 | 旧版本被 `/favicon.ico` 重复触发，更新代码重新部署即可；另检查控制台「触发器」是否有重复的 Cron |
| `签到结果：✅ 成功（今日已签到）` `签到积分：+0` | 当天已签过，重复签到不加分，属正常 |
| 签到失败 `会话已失效(401)` | Cookie 模式的 Session 过期（约 13~14 天），登录 trae.cn 重新抓 Cookie 后更新（本地部署：`npm run deploy`；一键部署：控制台变量处粘贴新值） |
| 签到失败 `自动续期失败（10101 ...）` | RefreshToken 失效（过期 / 客户端切换过账号 / 解密常量过期），在客户端登录该账号后 `npm run extract` + `npm run deploy` |
| `extract` 报 `密文头部不符合预期` | 客户端更新了加密方案，需重新逆向（参考 [qilimixingkong/trae-checkin](https://github.com/qilimixingkong/trae-checkin) TECH_DESIGN §6.4），期间可退回 Cookie 模式 |
| 签到失败 `9074 参与用户太多` | 风控，脚本已自动换设备号重试；仍失败可把 cron 调到冷门时段（如北京凌晨） |

## 日常维护

- **改了代码 / 定时时间** → `npm run deploy`，部署完成后自动触发一次签到并显示结果；
- **续期凭证更新（约半年一次）** → 客户端登录该账号后 `npm run deploy`（自动重新提取上传，推送剩 14 天内会 ⚠️ 提醒）；
- **Session 过期更新（Cookie 模式）** → `npm run deploy` 在「Trae 登录凭证」处输入新值（自动记录更新日期，提醒才准确）；
- **只改其他密钥**（钉钉 / 飞书）→ 改 `secrets.json` 后 `npm run secrets`，无需部署；
- `secrets.json` 已在 `.gitignore` 中排除，不会误提交；若清空了真实值，下次部署时对应项
  会提示「文件中暂无此值」，回车 = 跳过不上传（云端保留旧值），输入新值则上传并写回。

## 修改签到时间

三种方式任选：

- **一键部署用户（无本地仓库）**：Cloudflare 控制台 → Workers & Pages → `trae-checkin` →
  设置（Settings）→ 触发器（Trigger Cron Events）→ 编辑 Cron。注意填的是 **UTC 时间**，
  北京时间 = UTC + 8（如想北京 08:30，填 `30 0 * * *`）；
- 本地部署时在「触发时间」提示处输入新的北京时间 `HH:MM`，自动换算为 UTC cron 并写回 `wrangler.toml`；
- 或手动编辑 `wrangler.toml` 后再部署：

```toml
[triggers]
crons = ["30 0 * * *"]   # UTC 时间，北京时间 = UTC+8
```

改完 `npm run deploy` 生效（控制台方式即时生效）。

## 免责声明

本项目与 ByteDance / Trae 官方无任何关系。签到与续期接口均为逆向的非公开接口，字段可能随官方更新变化；
使用自动签到请遵守 Trae 服务条款，风险自负。账号凭证仅保存在你自己的 Cloudflare 账号中。

