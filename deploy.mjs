// 交互式部署：部署前逐项确认 secrets 与定时触发时间，直接回车 = 沿用文件中的值，
// 输入新值则覆盖并写回 secrets.json / wrangler.toml（作为下次部署的默认值）。
// 更新 TRAE_SESSION(_N) 时自动记录更新日期（TRAE_SESSION_DATE(_N)），供 Worker 推送会话剩余天数。
// TRIGGER_KEY（手动触发鉴权）本地与云端都未配置时自动生成随机 UUID，已有则沿用不覆盖。
// 全部输入后有一行汇总与最终确认（回车=部署，n=取消），确认前不写文件、不部署。
// 之后依次执行 wrangler deploy（同步代码与 cron 触发时间）
// 和 wrangler secret bulk（上传/更新 secrets），
// 最后自动访问一次 Worker 根路径触发签到，并在终端显示签到结果。
// 输入流结束（如 CI 中 stdin 关闭）视为逐项回车，不挂起、沿用文件值。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

// 需要确认的变量：[变量名, 中文标签]，提示时中文在前、变量名在后便于对照 README；
// 变量名是云端/secrets.json 的真实键名，不可翻译；
// 多账号可在文件里加 TRAE_SESSION_2 等，或按同样格式加入此列表
const KEYS = [
  ["TRAE_SESSION", "Trae 登录凭证"],
  ["DINGTALK_WEBHOOK", "钉钉机器人 Webhook"],
  ["DINGTALK_SECRET", "钉钉加签密钥"],
  ["FEISHU_WEBHOOK", "飞书机器人 Webhook"],
  ["TRIGGER_KEY", "手动触发密钥"],
];
// 可选：通过参数指定其他 secrets 文件，如 node deploy.mjs secrets.test.json
const SECRETS_FILE = process.argv[2] || "secrets.json";
const WRANGLER_FILE = "wrangler.toml";
// cron 按北京时间输入（项目面向国内），wrangler 的 cron 是 UTC，内部换算
const BJ_OFFSET_MIN = 8 * 60;

// 展示用：截断长值，避免整段密钥刷屏
const preview = (v) =>
  typeof v === "string" && v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v || "";

// 云端已配置的 Secret 名单（wrangler 只能看名字、读不到值，仅用于判断存在性）。
// 查询失败（未登录 / 首次部署 Worker 尚不存在 / 离线）视为空集，TRIGGER_KEY 走自动生成
function listRemoteSecretNames() {
  try {
    // 必须用单字符串命令 + shell：args 数组与 shell 同用会触发 Node 的 DEP0190 弃用警告
    const r = spawnSync("npx wrangler secret list", {
      encoding: "utf8",
      shell: true,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"], // 不占用 stdin，避免与交互询问冲突
    });
    const start = r.stdout.indexOf("[");
    const end = r.stdout.lastIndexOf("]");
    if (r.status !== 0 || start < 0 || end < start) return new Set();
    return new Set(JSON.parse(r.stdout.slice(start, end + 1)).map((s) => s.name));
  } catch {
    return new Set();
  }
}

// 每日定时 cron（"M H * * *"，UTC）↔ 北京时间 HH:MM 互转；非每日定时的 cron 返回 null
export const cronToBeijing = (cron) => {
  const m = cron.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (!m) return null;
  const bj = (Number(m[2]) * 60 + Number(m[1]) + BJ_OFFSET_MIN) % (24 * 60);
  return `${String(Math.floor(bj / 60)).padStart(2, "0")}:${String(bj % 60).padStart(2, "0")}`;
};
export const beijingToCron = (text) => {
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Number(m[1]) : -1;
  const min = m ? Number(m[2]) : -1;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const utc = (h * 60 + min - BJ_OFFSET_MIN + 24 * 60) % (24 * 60);
  return `${String(utc % 60).padStart(2, "0")} ${Math.floor(utc / 60)} * * *`;
};
const isValidCron = (cron) =>
  /^[\d*,\-\/ ]+$/.test(cron) && cron.trim().split(/\s+/).length === 5;

// 把新 cron 写进 wrangler.toml 文本：更新 crons 行，并同步 [triggers] 上方的注释行；
// 找不到 crons 配置时返回 null（由调用方报错）
export function applyCron(toml, newCron) {
  if (!/crons = \[[^\]]*\]/.test(toml)) return null;
  let out = toml.replace(/crons = \[[^\]]*\]/, `crons = ["${newCron}"]`);
  const bj = cronToBeijing(newCron);
  if (bj) {
    const [mi, hr] = newCron.split(" ");
    out = out.replace(
      /(^#[^\n]*\n)(\[triggers\])/m,
      `# 每日北京时间 ${bj} 触发 = UTC ${String(hr).padStart(2, "0")}:${String(mi).padStart(2, "0")}，错开签到高峰\n$2`
    );
  }
  return out;
}

// 行队列询问器（导出供测试）：键盘输入与管道输入统一按行排队，
// 避免「行先于下一次提问到达」而被丢弃；流结束后未回答的项视为回车
export function createAsker(rl) {
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()("");
  });
  return (prompt) => {
    process.stdout.write(prompt);
    return new Promise((res) => {
      if (queue.length) res(queue.shift());
      else if (closed) res("");
      else waiters.push(res);
    });
  };
}

// 交互收集阶段（导出供测试）：逐项询问密钥与触发时间，最后汇总确认。
// 注意：所有询问完成后由调用方关闭 rl；此函数不写任何文件。
// 新值直接记录在传入的 secrets 上；remoteSecrets 为云端已有 Secret 名单（用于 TRIGGER_KEY 提示）；
// 返回 { confirmed, changed, changedKeys, newCron }
export async function collectChanges(ask, secrets, curCron, remoteSecrets = new Set()) {
  const before = { ...secrets };
  console.log("部署前确认（直接回车 = 沿用文件中的现有值）：");
  for (const [key, label] of KEYS) {
    const cur = secrets[key] || "";
    let tip;
    if (cur) tip = `回车=沿用 ${preview(cur)}`;
    else if (key === "TRIGGER_KEY")
      tip = remoteSecrets.has(key)
        ? "云端已配置（值不可读取），回车=沿用云端"
        : "回车=自动生成随机密钥";
    else tip = "文件中暂无此值，回车=跳过";
    const ans = (await ask(`${label} ${key}（${tip}）: `)).trim();
    if (ans) secrets[key] = ans;
  }

  const curBj = curCron ? cronToBeijing(curCron) : null;
  const cronTip = curBj
    ? `回车=沿用 北京 ${curBj}`
    : curCron
      ? `回车=沿用 cron: ${curCron}`
      : "wrangler.toml 未配置 crons，回车=不改";
  let newCron = curCron;
  for (;;) {
    const ans = (await ask(`触发时间（北京时间 HH:MM，${cronTip}）: `)).trim();
    if (!ans) break;
    const converted = ans.includes(":") ? beijingToCron(ans) : ans.replace(/\s+/g, " ");
    if (converted && (ans.includes(":") || isValidCron(converted))) {
      newCron = converted;
      break;
    }
    console.error("  无效输入：请输入北京时间 HH:MM（如 08:30）或 5 段 UTC cron，或直接回车沿用");
  }

  // 汇总确认：这一步回车之前不写文件、不部署
  const changedPairs = KEYS.filter(([k]) => secrets[k] && secrets[k] !== before[k]);
  const changed = changedPairs.map(([k]) => k);
  const changedKeys = changedPairs.map(([, label]) => label);
  const newBj = cronToBeijing(newCron);
  console.log("—— 即将部署 ——");
  console.log(
    `密钥：${changedKeys.length ? `更新 ${changedKeys.join("、")}` : "沿用现有值"}`
  );
  console.log(
    `触发时间：${
      newCron !== curCron
        ? `改为 ${newBj ? `北京 ${newBj}` : newCron}`
        : curBj
          ? `北京 ${curBj}（沿用）`
          : "沿用当前配置"
    }`
  );
  const go = (await ask("确认执行部署？（回车=部署，n=取消）: ")).trim().toLowerCase();
  return {
    confirmed: go !== "n" && go !== "no" && go !== "否",
    changed,
    changedKeys,
    newCron,
  };
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // 读取现有值；文件缺失或损坏时按空处理，不中断部署
  let secrets = {};
  try {
    secrets = JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
  } catch {}

  let toml = "";
  try {
    toml = readFileSync(WRANGLER_FILE, "utf8");
  } catch {}
  const curCron = (toml.match(/crons = \[([^\]]*)\]/)?.[1] || "")
    .replace(/["']/g, "")
    .trim();

  // 云端已有 Secret 名单：仅用于 TRIGGER_KEY 的存在性判断。
  // 只在本地未配置 TRIGGER_KEY 时才查询（需联网，可能耗时数秒）；已有则无需关心云端状态
  let remoteSecrets = new Set();
  if (!secrets.TRIGGER_KEY) {
    console.log("查询云端已配置的 Secret…");
    remoteSecrets = listRemoteSecretNames();
  }

  // 所有询问结束后才关闭输入流（此前版本提前关闭，导致触发时间询问被跳过）
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = createAsker(rl);
  const { confirmed, changed, newCron } = await collectChanges(ask, secrets, curCron, remoteSecrets);
  rl.close();

  if (!confirmed) {
    console.log("已取消：未修改任何文件、未部署");
    process.exit(0);
  }

  // TRIGGER_KEY 三种情况：本地有 → 沿用；本地无但云端有 → 沿用云端不覆盖（值不可读取）；
  // 两边都没有 → 自动生成随机密钥并随本次部署上传
  let triggerKeyNote = "";
  if (!secrets.TRIGGER_KEY) {
    if (remoteSecrets.has("TRIGGER_KEY"))
      triggerKeyNote = "TRIGGER_KEY：云端已配置，沿用云端值（如需更换，部署时输入新密钥）";
    else {
      secrets.TRIGGER_KEY = randomUUID();
      triggerKeyNote = `已自动生成 TRIGGER_KEY：${secrets.TRIGGER_KEY}（手动访问 Worker URL 需带 ?key=此值）`;
    }
  }

  // 更新 TRAE_SESSION(_N) 时同步记录该会话的更新日期（存入 secrets.json 一并 bulk 上传），
  // Worker 据此在每天的推送中显示各账号的会话剩余天数；
  // 已有会话缺失日期时以今天补记（无法得知真实登录日期，剩余天数估算偏乐观）
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const dateNotes = [];
  for (const k of Object.keys(secrets)) {
    const m = k.match(/^TRAE_SESSION(_\d+)?$/);
    if (!m) continue;
    const dateKey = `TRAE_SESSION_DATE${m[1] || ""}`;
    if ((changed.includes(k) || !secrets[dateKey]) && secrets[dateKey] !== today) {
      secrets[dateKey] = today;
      dateNotes.push(`${dateKey}=${today}`);
    }
  }

  // 确认后才写回：secrets.json 按 KEYS 顺序重排，保留文件中已有的其他键
  const merged = {};
  for (const [key] of KEYS) if (secrets[key]) merged[key] = secrets[key];
  for (const [k, v] of Object.entries(secrets))
    if (!(k in merged) && typeof v === "string" && v) merged[k] = v;
  writeFileSync(SECRETS_FILE, JSON.stringify(merged, null, 2) + "\n");

  if (toml && newCron !== curCron) {
    const updated = applyCron(toml, newCron);
    if (updated == null) {
      console.error(`${WRANGLER_FILE} 未找到 crons 配置（[triggers] 段），请手动补充后再部署`);
      process.exit(1);
    }
    writeFileSync(WRANGLER_FILE, updated);
    const bj = cronToBeijing(newCron);
    console.log(`已更新触发时间：${bj ? `北京 ${bj}` : `cron ${newCron}`}`);
  }
  if (dateNotes.length)
    console.log("会话更新日期已记录：" + dateNotes.join("，"));
  if (triggerKeyNote) console.log(triggerKeyNote);

  const q = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
  const run = (args) => {
    // 单字符串命令 + shell，避免 args 数组触发 DEP0190 警告
    const r = spawnSync(["npx", ...args].map(q).join(" "), { stdio: "inherit", shell: true });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };

  run(["wrangler", "deploy"]);
  run(["wrangler", "secret", "bulk", SECRETS_FILE]);
  console.log("部署完成：代码 / cron 触发时间 / secrets 均已同步");

  // 部署完成后自动触发一次签到：直接在本地运行同款签到逻辑（import 云端同代码），
  // 不依赖 workers.dev 域名（该域名在部分地区网络不可达）；结果与钉钉/飞书推送照常发出
  try {
    console.log("自动触发一次签到（本地运行同款逻辑）…");
    await new Promise((r) => setTimeout(r, 2000)); // 等 secrets 传播（新会话/新密钥生效）
    const { default: worker } = await import("./src/index.js");
    const env = { ...secrets }; // TRAE_SESSION / 钉钉配置 / TRIGGER_KEY 等
    const url = new URL("https://localhost/");
    if (env.TRIGGER_KEY) url.searchParams.set("key", env.TRIGGER_KEY); // 与线上手动触发同一鉴权
    const resp = await worker.fetch(new Request(url), env);
    console.log("—— 签到结果 ——\n" + (await resp.text()));
  } catch (e) {
    console.log(`自动触发失败：${e.message}（可稍后手动访问 Worker URL 触发）`);
  }
}
