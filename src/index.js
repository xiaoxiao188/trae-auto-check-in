const BASE = "https://api.trae.cn";

async function post(path, headers, body = "") {
  const resp = await fetch(BASE + path, { method: "POST", headers, body });
  return { status: resp.status, text: await resp.text() };
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
  const data = JSON.parse(text);
  const token = data?.Result?.Token;
  if (status === 401)
    throw new Error("会话已失效(401)，需重新登录 trae.cn 更新 TRAE_SESSION");
  if (status !== 200 || !token)
    throw new Error(`GetUserToken 失败: HTTP ${status} ${text.slice(0, 200)}`);
  return token;
}

async function checkin(token, deviceId) {
  const { status, text } = await post(
    "/trae/api/v2/ug/checkin_credits/claim",
    {
      "Authorization": "Cloud-IDE-JWT " + token,
      "X-User-Region": "cn",
      "x-device-id": deviceId,
      "Content-Type": "application/json",
      "User-Agent": "TraeCheckin/1.0",
    },
    "{}"
  );
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { http: status, body };
}

// 查询今日签到状态，补拿「签到积分」（credits 基础分 + extra_credits 额外分）
async function getCheckinStatus(token, deviceId) {
  try {
    const { status, text } = await post(
      "/trae/api/v2/ug/checkin_credits/status",
      {
        "Authorization": "Cloud-IDE-JWT " + token,
        "X-User-Region": "cn",
        "x-device-id": deviceId,
        "Content-Type": "application/json",
        "User-Agent": "TraeCheckin/1.0",
      },
      "{}"
    );
    if (status !== 200) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 查询额度使用汇总，返回「通用积分」余额
// 积分包按 entitlement_base_info.available_endpoint 区分适用范围：
// 0 = 通用积分（TraeCode / TraeWork 均可用），1 = Work 专属积分（仅 TraeWork）
// 通用积分 = Σ(通用包的 credits_limit - 已用)
async function getGeneralCredits(token, deviceId) {
  try {
    const { status, text } = await post(
      "/trae/api/v2/pay/web_user_ent_usage",
      {
        "Authorization": "Cloud-IDE-JWT " + token,
        "X-User-Region": "cn",
        "x-device-id": deviceId,
        "Content-Type": "application/json",
        "User-Agent": "TraeCheckin/1.0",
      },
      "{}"
    );
    if (status !== 200) return null;
    const packs = JSON.parse(text)?.user_entitlement_pack_list;
    if (!Array.isArray(packs)) return null;
    let total = 0,
      found = false;
    for (const p of packs) {
      const info = p?.entitlement_base_info;
      if (!info || info.available_endpoint !== 0) continue; // 只统计通用积分包
      const limit =
        info.quota?.credits_limit ??
        info.product_extra?.package_extra?.quota?.credits_limit ??
        info.product_extra?.subscription_extra?.quota?.credits_limit;
      if (typeof limit !== "number") continue;
      found = true;
      total += limit - (p.usage?.credits_amount ?? 0);
    }
    if (!found) return null;
    return Math.round(total * 100) / 100;
  } catch {
    return null;
  }
}

const randomDeviceId = () => String(Math.floor(Math.random() * 9e15) + 1e15);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notifyFeishu(webhook, text) {
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } }),
  }).catch(() => {});
}

// 钉钉群机器人推送（markdown 消息，标题带下划线样式）。
// 若机器人开启了"加签"安全设置，需配置 DINGTALK_SECRET
async function notifyDingTalk(webhook, secret, title, mdText) {
  webhook = (webhook || "").trim();
  secret = (secret || "").trim();
  if (!webhook) return "钉钉：未配置 DINGTALK_WEBHOOK";
  let url = webhook;
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
    const sign = encodeURIComponent(
      btoa(String.fromCharCode(...new Uint8Array(sig)))
    );
    url += `&timestamp=${timestamp}&sign=${sign}`;
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

// 读取 TRAE_SESSION, TRAE_SESSION_2, TRAE_SESSION_3 ...
function iterAccounts(env) {
  const accounts = [];
  if (env.TRAE_SESSION)
    accounts.push({
      name: "账号 1",
      session: env.TRAE_SESSION,
      deviceId: env.TRAE_DEVICE_ID || "",
    });
  for (let n = 2; ; n++) {
    const s = env[`TRAE_SESSION_${n}`];
    if (!s) break;
    accounts.push({
      name: `账号 ${n}`,
      session: s,
      deviceId: env[`TRAE_DEVICE_ID_${n}`] || "",
    });
  }
  return accounts;
}

async function runCheckin(env) {
  const accounts = iterAccounts(env);
  if (!accounts.length) return "缺少环境变量 TRAE_SESSION";

  const results = [];
  for (const [i, acc] of accounts.entries()) {
    if (i > 0) await sleep(3000 + Math.random() * 3000); // 多账号错开，规避风控
    let deviceId = acc.deviceId || randomDeviceId();
    try {
      const token = await getToken(acc.session);
      let result = await checkin(token, deviceId);
      let code = result.body?.code ?? -1;
      // 9074「参与用户太多」→ 换新设备号重试，最多 5 次
      for (let attempt = 1; code === 9074 && attempt < 5; attempt++) {
        deviceId = randomDeviceId();
        await sleep(800 + Math.random() * 700);
        result = await checkin(token, deviceId);
        code = result.body?.code ?? -1;
      }
      if (result.http === 200 && (code === 0 || result.body?.checked_in)) {
        // 签到积分：优先用 claim 返回的 credits；重复签到时 claim 不带分，改查 status
        let earned = result.body?.credits;
        if (earned == null) {
          const st = await getCheckinStatus(token, deviceId);
          if (st) earned = (st.credits ?? 0) + (st.extra_credits ?? 0);
        }
        // 通用积分：通用积分包（available_endpoint=0）的额度剩余之和
        const general = await getGeneralCredits(token, deviceId);
        results.push({ name: acc.name, ok: true, earned: earned ?? 0, general });
      } else {
        results.push({
          name: acc.name,
          ok: false,
          reason: result.body?.message || "HTTP " + result.http,
        });
      }
    } catch (e) {
      results.push({ name: acc.name, ok: false, reason: e.message });
    }
  }

  const time = new Date(Date.now() + 8 * 3600e3)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const lines = ["Trae 自动签到"];
  for (const [i, r] of results.entries()) {
    if (i > 0) lines.push(""); // 多账号之间空一行分隔
    lines.push(`帐号：${r.name}`);
    if (r.ok) {
      lines.push("签到结果：✅ 成功");
      lines.push(`签到积分：+${r.earned}`);
      if (r.general != null) lines.push(`通用积分：${r.general}`);
    } else {
      lines.push(`签到结果：❌ 失败（${r.reason}）`);
    }
  }
  lines.push(`时间：${time}`);
  const summary = lines.join("\n");
  // 钉钉用 markdown 推送：标题加粗（#### **标题**），标题下用 --- 分割线实现下划线效果；
  // markdown 单换行会折叠，行与行之间用空行分隔
  const mdSummary = `#### **${lines[0]}**\n\n---\n\n` + lines.slice(1).join("\n\n");
  const pushResults = await Promise.all([
    notifyFeishu(env.FEISHU_WEBHOOK, summary),
    notifyDingTalk(env.DINGTALK_WEBHOOK, env.DINGTALK_SECRET, lines[0], mdSummary),
  ]);
  const pushInfo = pushResults.filter(Boolean).join("\n");
  return pushInfo ? summary + "\n---\n" + pushInfo : summary;
}

export default {
  // Cron Trigger 入口：每天定时自动执行
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheckin(env).then((r) => console.log(r)));
  },
  // 浏览器访问根路径可手动触发一次，方便测试；
  // 忽略 /favicon.ico 等浏览器附加请求，避免重复触发签到和推送
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return new Response(null, { status: 204 });
    const result = await runCheckin(env);
    return new Response(result, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
