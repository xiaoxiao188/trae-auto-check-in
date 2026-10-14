import { BASE, REFRESH_UA, renewToken } from "./trae-auth.js";

// 会话（X-Cloudide-Session）有效期实测约 13 天出头，从浏览器登录时算起；
// 按 13 天估算剩余天数（宁早勿晚），用于到期提醒
const SESSION_TTL_DAYS = 13;
// RefreshToken 有效期约半年（实测 180 天），剩 14 天内提醒重新提取
const REFRESH_WARN_DAYS = 14;

const bjNow = () => new Date(Date.now() + 8 * 3600e3); // 北京时间（UTC+8，不受运行环境时区影响）

// 签到相关接口的公共鉴权头。refresh 模式仿真实客户端（Electron UA + 全套设备头 +
// body 带 req_source），否则会被判为脚本触发 9074（magpie#808 实测）
const authHeaders = (token, deviceId, mode = "cookie") => ({
  "Authorization": "Cloud-IDE-JWT " + token,
  "X-User-Region": "cn",
  "x-device-id": deviceId,
  "Content-Type": "application/json",
  ...(mode === "refresh"
    ? {
        "User-Agent": REFRESH_UA,
        "x-device-brand": "LENOVO 82XW",
        "x-device-type": "Windows",
        "x-os-version": "10.0.26100",
        "x-app-version": "0.1.64",
      }
    : { "User-Agent": "TraeCheckin/1.0" }),
});
// 签到接口请求体：客户端发 {req_source:1}，Cookie 模式沿用原 {}
const apiBody = (mode) => (mode === "refresh" ? '{"req_source":1}' : "{}");

// POST 请求：网络异常或上游 5xx 时自动重试（共 3 次，间隔递增），避免 cron 当天
// 一次网络抖动就错过签到；4xx 属业务错误（401 失效、风控等）不重试，直接返回
async function post(path, headers, body = "") {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(700 * attempt + Math.random() * 500);
    try {
      const resp = await fetch(BASE + path, { method: "POST", headers, body });
      const text = await resp.text();
      if (resp.status < 500 || attempt === 2) return { status: resp.status, text };
      lastErr = new Error("HTTP " + resp.status);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 用 X-Cloudide-Session 换新 JWT
async function getToken(session) {
  const { status, text } = await post("/cloudide/api/v3/common/GetUserToken", {
    "Cookie": "X-Cloudide-Session=" + session,
    "Referer": "https://www.trae.cn/",
    "Origin": "https://www.trae.cn",
    "User-Agent": "TraeCheckin/1.0",
    "Accept": "application/json, text/plain, */*",
  });
  if (status === 401)
    throw new Error("会话已失效(401)，需重新登录 trae.cn 更新 TRAE_SESSION");
  let token = null;
  try {
    token = JSON.parse(text)?.Result?.Token;
  } catch {} // 非 JSON（如网关错误页）按无 token 处理，走下面的统一报错
  if (status !== 200 || !token)
    throw new Error(`GetUserToken 失败: HTTP ${status} ${text.slice(0, 200)}`);
  return token;
}

async function checkin(token, deviceId, mode = "cookie") {
  const { status, text } = await post(
    "/trae/api/v2/ug/checkin_credits/claim",
    authHeaders(token, deviceId, mode),
    apiBody(mode)
  );
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { http: status, body };
}

// 查询今日签到状态（用于判断「今日已签到」）。注意：extra_credits 只是
// 「可额外获得」，并未随签到入账（额度包记录证实每日签到实际入账 = credits）
async function getCheckinStatus(token, deviceId, mode = "cookie") {
  try {
    const { status, text } = await post(
      "/trae/api/v2/ug/checkin_credits/status",
      authHeaders(token, deviceId, mode),
      apiBody(mode)
    );
    if (status !== 200) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 查询额度使用汇总，返回 { general, work, total, todayCheckin }
// 积分包按 entitlement_base_info.available_endpoint 区分适用范围：
// 0 = 通用积分（TraeCode / TraeWork 均可用），1 = Work 专属积分（仅 TraeWork）
// general = Σ(通用包剩余)，work = Σ(Work专属包剩余)，total = 全部可量化包的剩余之和
// todayCheckin = 今日签到实际入账（entitlement_id 形如 checkin_20260922_xxx 的包额度）
// 注意：free_xxx 基础免费包没有 credits_limit（不可量化），不计入任何汇总
async function getCredits(token, deviceId, mode = "cookie") {
  try {
    const { status, text } = await post(
      "/trae/api/v2/pay/web_user_ent_usage",
      authHeaders(token, deviceId, mode),
      "{}"
    );
    if (status !== 200) return null;
    const packs = JSON.parse(text)?.user_entitlement_pack_list;
    if (!Array.isArray(packs)) return null;
    // 北京时间当天日期，用于匹配今日签到包（checkin_yyyyMMdd_xxx）
    const today = bjNow().toISOString().slice(0, 10).replace(/-/g, "");
    const r2 = (v) => Math.round(v * 100) / 100;
    let general = 0,
      work = 0,
      other = 0,
      found = false,
      todayCheckin = 0;
    for (const p of packs) {
      const info = p?.entitlement_base_info;
      if (!info) continue;
      const limit =
        info.quota?.credits_limit ??
        info.product_extra?.package_extra?.quota?.credits_limit ??
        info.product_extra?.subscription_extra?.quota?.credits_limit;
      if (typeof limit !== "number") continue; // 无额度上限的包（如免费基础包）不可量化
      found = true;
      const remain = limit - (p.usage?.credits_amount ?? 0);
      if (info.available_endpoint === 0) general += remain;
      else if (info.available_endpoint === 1) work += remain;
      else other += remain;
      if (info.available_endpoint === 0 &&
          typeof info.entitlement_id === "string" &&
          info.entitlement_id.startsWith("checkin_" + today)) {
        todayCheckin += limit;
      }
    }
    if (!found) return null;
    return {
      general: r2(general),
      work: r2(work),
      total: r2(general + work + other),
      todayCheckin,
    };
  } catch {
    return null;
  }
}

// 拉取账号资料（昵称 / 脱敏手机号，逆向自 www.trae.cn/dashboard），用于把推送里的
// 「账号 N」换成直观的昵称/手机号。NonPlainTextMobile 官方已脱敏（如 138****1234），可安全推送。
// 请求头与 TraeTools 同款：JWT + Session Cookie + Referer/Origin，无需 x-device-id；
// 失败返回 null，不影响签到主流程（展示回退为「账号 N」）
async function getUserInfo(token, session) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "Referer": "https://www.trae.cn/",
      "Origin": "https://www.trae.cn",
      "User-Agent": "TraeCheckin/1.0",
    };
    if (token) headers["Authorization"] = "Cloud-IDE-JWT " + token;
    if (session) headers["Cookie"] = "X-Cloudide-Session=" + session;
    const { status, text } = await post("/cloudide/api/v3/trae/GetUserInfo", headers);
    if (status !== 200) return null;
    const r = JSON.parse(text)?.Result;
    if (!r || typeof r !== "object") return null;
    return {
      userId: typeof r.UserID === "string" ? r.UserID : null,
      screenName: typeof r.ScreenName === "string" ? r.ScreenName : null,
      mobileMasked: typeof r.NonPlainTextMobile === "string" ? r.NonPlainTextMobile : null,
    };
  } catch {
    return null;
  }
}

// 推送里展示用的账号名：昵称 + 脱敏手机号优先，都拿不到则回退「账号 N」
function displayLabel(acc, info) {
  const parts = [];
  if (info?.screenName) parts.push(info.screenName);
  if (info?.mobileMasked) parts.push(info.mobileMasked);
  return parts.length ? parts.join(" ") : acc.name;
}

// 16 位数字设备号：与 randomUUID、HMAC 加签统一用 crypto 随机源
const randomDeviceId = () => {
  const v = new BigUint64Array(1);
  crypto.getRandomValues(v);
  return String((v[0] % 9_000_000_000_000_000n) + 1_000_000_000_000_000n);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 飞书推送用卡片（msg_type=interactive）：标题进卡片 header（成功绿/警告橙/失败红），
// 正文用 lark_md（标签加粗、✅绿 ❌红），时间戳进 note 小字。
// 注意飞书 markdown 子集与钉钉不同：不支持 # 标题、<font> 仅支持 green/red/grey
export function buildFeishuCard(lines) {
  const hasFail = lines.some((l) => l.includes("❌"));
  const hasWarn = lines.some((l) => l.includes("⚠️"));
  const body = lines
    .slice(1, -1) // 首行标题 → header；末行签到时间 → note
    .map((line) => {
      const m = line.match(/^([^：]+)：(.+)$/);
      if (!m) return line;
      const [, label, value] = m;
      let v = value;
      if (value.includes("✅")) v = `<font color='green'>${value}</font>`;
      else if (value.includes("❌")) v = `<font color='red'>${value}</font>`;
      return `**${label}：**${v}`;
    })
    .join("\n");
  return {
    config: { wide_screen_mode: true },
    header: {
      template: hasFail ? "red" : hasWarn ? "orange" : "green",
      title: { tag: "plain_text", content: lines[0] },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: body } },
      { tag: "hr" },
      { tag: "note", elements: [{ tag: "plain_text", content: lines[lines.length - 1] }] },
    ],
  };
}

// 飞书推送：卡片消息（interactive），比纯文本清晰
async function notifyFeishu(webhook, card) {
  webhook = (webhook || "").trim();
  if (!webhook) return null;
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "interactive", card }),
    });
    return `飞书：HTTP ${resp.status} ${await resp.text()}`;
  } catch (e) {
    return `飞书：请求异常 ${e.message}`;
  }
}

// 钉钉群机器人推送（markdown 消息，标题带下划线样式）。
// 若机器人开启了"加签"安全设置，需配置 DINGTALK_SECRET
async function notifyDingTalk(webhook, secret, title, mdText) {
  webhook = (webhook || "").trim();
  secret = (secret || "").trim();
  if (!webhook) return "钉钉：未配置 DINGTALK_WEBHOOK";
  let url;
  try {
    url = new URL(webhook);
  } catch {
    return "钉钉：Webhook 地址无效";
  }
  if (secret) {
    const timestamp = Date.now();
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`${timestamp}\n${secret}`)
    );
    // searchParams 会做 URL 编码，直接放原始 base64（先 encodeURIComponent 会双重编码）
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("sign", btoa(String.fromCharCode(...new Uint8Array(sig))));
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { title, text: mdText },
      }),
    });
    const respText = await resp.text();
    return `钉钉：HTTP ${resp.status} ${respText}`;
  } catch (e) {
    return `钉钉：请求异常 ${e.message}`;
  }
}

// 读取各账号凭证：Cookie 模式 TRAE_SESSION（账号 1）、TRAE_SESSION_2、… 与
// 续期模式 TRAE_REFRESH_TOKEN（账号 1）、TRAE_REFRESH_TOKEN_2、…（两者可共存，续期优先），
// 及各自的设备号与日期。不在首个缺失编号处停止：中间断号的账号仍会签到，
// 缺失编号记入 gaps 由调用方在推送中提示，避免悄悄漏签
export function iterAccounts(env) {
  const nums = [];
  if (env.TRAE_SESSION || env.TRAE_REFRESH_TOKEN) nums.push(1);
  for (let n = 2; n <= 99; n++)
    if (env[`TRAE_SESSION_${n}`] || env[`TRAE_REFRESH_TOKEN_${n}`]) nums.push(n);
  const gaps = [];
  for (let n = 1; n < nums[nums.length - 1]; n++)
    if (!nums.includes(n)) gaps.push(n);
  return {
    gaps,
    accounts: nums.map((n) => {
      const suffix = n === 1 ? "" : `_${n}`;
      return {
        name: `账号 ${n}`,
        session: env[`TRAE_SESSION${suffix}`] || "",
        refreshToken: env[`TRAE_REFRESH_TOKEN${suffix}`] || "",
        refreshExpiry: env[`TRAE_REFRESH_EXPIRY${suffix}`] || "",
        refreshLabel: env[`TRAE_REFRESH_LABEL${suffix}`] || "",
        deviceId: env[`TRAE_DEVICE_ID${suffix}`] || "",
        sessionDate: env[`TRAE_SESSION_DATE${suffix}`] || "",
      };
    }),
  };
}

// 会话剩余天数：sessionDate 由 deploy 脚本更新对应 TRAE_SESSION(_N) 时自动记录；
// 按 SESSION_TTL_DAYS 估算（宁早勿晚），日期未知返回 null
function sessionLeftDays(sessionDate) {
  if (!sessionDate) return null;
  const ms = bjNow() - Date.parse(sessionDate + "T00:00:00+08:00");
  if (!Number.isFinite(ms)) return null;
  return SESSION_TTL_DAYS - Math.floor(ms / 86400e3);
}

// RefreshToken 剩余天数：按提取时记录的到期日（TRAE_REFRESH_EXPIRY）计算，未知返回 null
function refreshLeftDays(expiry) {
  if (!expiry) return null;
  const ms = Date.parse(expiry + "T00:00:00+08:00") - bjNow();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86400e3);
}

async function runCheckin(env) {
  const { accounts, gaps } = iterAccounts(env);
  if (!accounts.length) return "缺少环境变量 TRAE_SESSION 或 TRAE_REFRESH_TOKEN";

  // 续期模式的设备密钥对（TRAE_DEVICE，机器级各账号共用）；缺失或损坏时相关账号回退 Cookie 模式
  let device = null;
  if (env.TRAE_DEVICE) {
    try {
      device = JSON.parse(env.TRAE_DEVICE);
    } catch {}
    if (!device?.PrivateKey || !device?.DeviceID || !device?.DevicePublicKey) device = null;
  }

  const results = [];
  for (const [i, acc] of accounts.entries()) {
    if (i > 0) await sleep(3000 + Math.random() * 3000); // 多账号错开，规避风控
    let deviceId = acc.deviceId || randomDeviceId();
    // 续期模式无 Cookie，GetUserInfo 不可用（401），用提取时记录的昵称兜底
    let name = acc.refreshLabel || acc.name;
    let mode = acc.refreshToken && device ? "refresh" : "cookie";
    try {
      let token;
      if (mode === "refresh") {
        const r = await renewToken(acc.refreshToken, device);
        if (r.ok) {
          token = r.token;
        } else if (acc.session) {
          token = await getToken(acc.session); // 续期失败回退 Cookie 模式
          mode = "cookie";
        } else {
          throw new Error(
            `自动续期失败（${r.code ?? ""} ${r.error}）：请运行 npm run extract 重新提取`
          );
        }
      } else {
        token = await getToken(acc.session);
      }
      // 昵称与今日签到状态相互独立，并行查询省一个来回
      const [info, st0] = await Promise.all([
        mode === "cookie" ? getUserInfo(token, acc.session) : null,
        getCheckinStatus(token, deviceId, mode),
      ]);
      if (mode === "cookie") {
        // 接口拿到昵称才覆盖（GetUserInfo 失败时保留提取时记录的标签）
        const live = displayLabel(acc, info);
        if (live !== acc.name) name = live;
      }
      // 今日已签到则跳过 claim，直接显示 +0（避免重复请求触发风控）
      if (st0?.checked_in) {
        const usage = await getCredits(token, deviceId, mode);
        results.push({
          name,
          mode,
          ok: true,
          earned: 0,
          already: true,
          general: usage?.general,
          work: usage?.work,
          total: usage?.total,
        });
        continue;
      }
      let result = await checkin(token, deviceId, mode);
      let code = result.body?.code ?? -1;
      // 9074「参与用户太多」→ 换新设备号重试，最多 5 次
      for (let attempt = 1; code === 9074 && attempt < 5; attempt++) {
        deviceId = randomDeviceId();
        await sleep(800 + Math.random() * 700);
        result = await checkin(token, deviceId, mode);
        code = result.body?.code ?? -1;
      }
      if (result.http === 200 && (code === 0 || result.body?.checked_in)) {
        // 签到积分 = 本次实际入账：优先 claim 返回值；claim 不带分时取当日「签到奖励」积分包额度
        const usage = await getCredits(token, deviceId, mode);
        let earned = result.body?.credits ?? null;
        if (earned == null)
          earned = usage?.todayCheckin > 0 ? usage.todayCheckin : 0;
        results.push({
          name,
          mode,
          ok: true,
          earned,
          already: false,
          general: usage?.general,
          work: usage?.work,
          total: usage?.total,
        });
      } else {
        results.push({
          name,
          mode,
          ok: false,
          reason: result.body?.message || "HTTP " + result.http,
        });
      }
    } catch (e) {
      results.push({ name, mode, ok: false, reason: e.message });
    }
  }

  // 每个账号的凭证模式独立，剩余天数按账号附加到对应结果
  // （循环内每个账号恰好产生一条 result，顺序与 accounts 一致）
  for (const [i, r] of results.entries())
    r.sessionLeft =
      r.mode === "refresh"
        ? refreshLeftDays(accounts[i].refreshExpiry)
        : sessionLeftDays(accounts[i].sessionDate);

  const time = bjNow().toISOString().replace("T", " ").slice(0, 19);
  const lines = ["Trae 自动签到"];
  if (gaps.length)
    lines.push(
      `⚠️ 编号 ${gaps.join("、")} 的账号凭证缺失（TRAE_SESSION / TRAE_REFRESH_TOKEN 均未配置），不会签到`
    );
  for (const [i, r] of results.entries()) {
    if (i > 0) lines.push(""); // 多账号之间空一行分隔
    lines.push(`账号：${r.name}`);
    if (r.ok) {
      lines.push("签到结果：✅ 成功" + (r.already ? "（今日已签到）" : ""));
      lines.push(`签到积分：+${r.earned}`);
      if (r.general != null) lines.push(`通用积分：${r.general}`);
      if (r.work != null) lines.push(`Work 专属积分：${r.work}`);
      if (r.total != null) lines.push(`总可用积分：${r.total}`);
    } else {
      lines.push(`签到结果：❌ 失败（${r.reason}）`);
    }
    // 凭证到期提醒：剩 3 天以内 ⚠️ 高亮，避免突然失效才发现
    if (r.sessionLeft != null) {
      if (r.mode === "refresh") {
        if (r.sessionLeft <= 0)
          lines.push("⚠️ 续期凭证可能已过期：请在 Trae 客户端登录该账号后运行 npm run extract 重新提取");
        else if (r.sessionLeft <= REFRESH_WARN_DAYS)
          lines.push(`⚠️ 续期凭证约剩 ${r.sessionLeft} 天：请在 Trae 客户端登录状态下运行 npm run extract 刷新`);
        else lines.push(`凭证模式：自动续期（约剩 ${r.sessionLeft} 天）`);
      } else {
        if (r.sessionLeft <= 0)
          lines.push("⚠️ 会话可能已过期：请重新登录 trae.cn，复制新的 X-Cloudide-Session 后运行 npm run deploy");
        else if (r.sessionLeft <= 3)
          lines.push(`⚠️ 会话约剩 ${r.sessionLeft} 天：请尽快重新登录 trae.cn 更新（复制 Cookie 后 npm run deploy）`);
        else lines.push(`会话有效期：约剩 ${r.sessionLeft} 天`);
      }
    } else if (r.mode === "refresh") {
      lines.push("凭证模式：自动续期");
    }
  }
  lines.push(`签到时间：${time}`);
  const summary = lines.join("\n");
  // 钉钉用 markdown 推送：标题加粗（#### **标题**），标题下用 --- 分割线实现下划线效果；
  // markdown 单换行会折叠，行与行之间用空行分隔；
  // 飞书用卡片推送（buildFeishuCard），与钉钉同样排版但支持颜色（成功绿/失败红）
  const mdSummary = `#### **${lines[0]}**\n\n---\n\n` + lines.slice(1).join("\n\n");
  const pushResults = await Promise.all([
    notifyFeishu(env.FEISHU_WEBHOOK, buildFeishuCard(lines)),
    notifyDingTalk(env.DINGTALK_WEBHOOK, env.DINGTALK_SECRET, lines[0], mdSummary),
  ]);
  const pushInfo = pushResults.filter(Boolean).join("\n");
  return pushInfo ? summary + "\n---\n" + pushInfo : summary;
}

export default {
  // Cron Trigger 入口：每天定时自动执行
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCheckin(env)
        .then((r) => console.log(r))
        .catch((e) => console.error("签到执行失败:", e))
    );
  },
  // 浏览器访问根路径可手动触发一次，方便测试；
  // 忽略 /favicon.ico 等浏览器附加请求，避免重复触发签到和推送；
  // 配置 TRIGGER_KEY 后需带 ?key=密钥 访问，防止 URL 泄露被他人触发推送或看到账号信息
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return new Response(null, { status: 204 });
    if (env.TRIGGER_KEY && url.searchParams.get("key") !== env.TRIGGER_KEY)
      return new Response(null, { status: 404 });
    const result = await runCheckin(env);
    return new Response(result, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
