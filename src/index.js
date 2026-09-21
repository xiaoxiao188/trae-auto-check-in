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

// 钉钉群机器人推送。若机器人开启了"加签"安全设置，需配置 DINGTALK_SECRET
async function notifyDingTalk(webhook, secret, text) {
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
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
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

  const ok = [],
    fail = [];
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
        ok.push(`${acc.name}(+${result.body.credits ?? 0}分)`);
      } else {
        fail.push(`${acc.name}(${result.body?.message || "HTTP " + result.http})`);
      }
    } catch (e) {
      fail.push(`${acc.name}(${e.message})`);
    }
  }

  const time = new Date(Date.now() + 8 * 3600e3)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const cronLabel = (env.CRON_LABEL || "每天 08:30（北京时间）").trim();
  const lines = ["Trae 签到结果", `时间：${time}`, `定时：${cronLabel}`];
  if (ok.length) lines.push("成功：" + ok.join("、"));
  if (fail.length) lines.push("失败：" + fail.join("、"));
  const summary = lines.join("\n");
  const pushResults = await Promise.all([
    notifyFeishu(env.FEISHU_WEBHOOK, summary),
    notifyDingTalk(env.DINGTALK_WEBHOOK, env.DINGTALK_SECRET, summary),
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
