// 从本机 Trae 客户端（Trae CN / TRAE SOLO CN）提取登录凭证，供 Worker 自动续期：
//   RefreshToken（约半年有效，Worker 每天用它换新 JWT 签到，无需再抓 Cookie）
//   + 设备 ECDSA P-256 密钥对（ExchangeToken 签名用，机器级，各账号共用）
// 提取时真实调用一次 ExchangeToken 验证凭证可用（该接口不轮换不吊销，不影响客户端登录态）。
// npm run deploy 部署前会自动调用 runExtract（账号 1，见 deploy.mjs），日常无需单独执行本脚本；
// 单独执行用于写入其他账号编号，或只更新 secrets.json 不部署。
// 注意：storage.json 只保存「当前登录账号」的凭证；在客户端里切换账号会使已提取的
// RefreshToken 被服务端吊销（社区实测），切换后需重新登录原账号再提取。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { decryptAuthBlob, renewToken } from "./src/trae-auth.js";

// 拼接写法规避编辑工具把长键名折叠成省略号（参照项目踩坑记录）
const AUTH_KEY = "iCubeAuthInfo://icube." + "cloudide";
const DC_PREFIX = "iCubeAuthInfo://icube-" + "dc:";

// %APPDATA% 下的候选客户端目录 → 参数组类型
const CLIENT_DIRS = [
  ["Trae CN", "trae"],
  ["Trae", "trae"],
  ["TRAE SOLO CN", "solo"],
  ["TRAE SOLO CN - Local", "solo"],
];

const bjNow = () => new Date(Date.now() + 8 * 3600e3);

function findStorage() {
  const appdata = process.env.APPDATA;
  if (!appdata)
    return { skipped: true, reason: "未找到 APPDATA 环境变量（自动提取仅支持 Windows）" };
  for (const [dir, clientType] of CLIENT_DIRS) {
    const p = join(appdata, dir, "User", "globalStorage", "storage.json");
    let data = null;
    try { data = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    if (data && typeof data[AUTH_KEY] === "string") return { path: p, data, clientType, dir };
  }
  return { skipped: true, reason: "未找到客户端登录态，请先在 Trae CN / TRAE SOLO CN 客户端登录账号" };
}

// 提取主流程（导出供 deploy.mjs 组合调用）：解密 + 验证，返回待写入的 secrets 键值，
// 不写文件、不退出进程（写文件由 CLI 或部署流程决定）。
// 返回 { ok:true, secrets, label, dir, expiry, days }，
// 或 { ok:false, skipped:true, reason }（环境不支持/未登录，属正常跳过），
// 或 { ok:false, reason }（解密失败、凭证失效等真实问题）
export async function runExtract({ account = 1, verify = true } = {}) {
  const found = findStorage();
  if (found.skipped) return { ok: false, skipped: true, reason: found.reason };
  const { path, data, clientType, dir } = found;

  let user;
  try {
    user = await decryptAuthBlob(data[AUTH_KEY]);
  } catch (e) {
    return { ok: false, reason: `解密登录态失败：${e.message}` };
  }
  if (!user.refreshToken || !user.userId)
    return { ok: false, reason: "登录态缺少 refreshToken，请在客户端重新登录后重试" };

  const dcKey = Object.keys(data).find((k) => k.startsWith(DC_PREFIX));
  if (!dcKey) return { ok: false, reason: "未找到设备密钥对（客户端未完成设备注册）" };
  let deviceCred;
  try {
    deviceCred = await decryptAuthBlob(data[dcKey]);
  } catch (e) {
    return { ok: false, reason: `解密设备密钥对失败：${e.message}` };
  }
  if (!deviceCred.privateKeyPEM || !deviceCred.publicKeyPEM)
    return { ok: false, reason: "设备密钥对不完整，请在客户端重新登录后重试" };

  // storage.json 上溯三级是客户端用户数据根目录，machineid 在那里
  const root = dirname(dirname(dirname(path)));
  let machineId = "";
  try { machineId = readFileSync(join(root, "machineid"), "utf8").trim(); } catch {}

  const device = {
    ClientType: clientType,
    DeviceID: dcKey.slice(DC_PREFIX.length),
    MachineID: machineId,
    DeviceName: os.hostname(),
    OSVersion: os.release(),
    OSInfo: "Windows",
    DevicePublicKey: deviceCred.publicKeyPEM,
    PrivateKey: deviceCred.privateKeyPEM,
  };

  const acct = user.account || {};
  const label = [acct.username, acct.nonPlainTextMobile].filter(Boolean).join(" ");
  console.log(`客户端：${dir}（${clientType} 参数组）`);
  console.log(`账号：${label || user.userId}（userId=${user.userId}）`);
  console.log(`RefreshToken 有效期至：${user.refreshExpiredAt || "未知"}`);

  // 验证：真实调一次 ExchangeToken（安全），确认凭证与参数组可用；换组成功则记录实际可用的组
  if (verify) {
    process.stdout.write("验证凭证（调用 ExchangeToken）… ");
    const r = await renewToken(user.refreshToken, device);
    if (!r.ok)
      return {
        ok: false,
        reason: `凭证不可用（${r.code ?? ""} ${r.error}）：可能已在客户端切换过账号或凭证已过期`,
      };
    if (r.clientType !== clientType)
      console.log(`\n参数组修正：${clientType} → ${r.clientType}（服务端只认后者）`);
    else console.log("可用 ✅");
    device.ClientType = r.clientType;
  } else {
    console.log("跳过验证（--no-verify）");
  }

  const suffix = account === 1 ? "" : `_${account}`;
  const secrets = {
    TRAE_DEVICE: JSON.stringify(device),
    [`TRAE_REFRESH_TOKEN${suffix}`]: user.refreshToken,
    [`TRAE_REFRESH_EXPIRY${suffix}`]: (user.refreshExpiredAt || "").slice(0, 10),
  };
  if (label) secrets[`TRAE_REFRESH_LABEL${suffix}`] = label;
  return {
    ok: true,
    secrets,
    label,
    dir,
    suffix,
    expiry: secrets[`TRAE_REFRESH_EXPIRY${suffix}`],
    days: user.refreshExpiredAt
      ? Math.ceil((Date.parse(user.refreshExpiredAt) - bjNow()) / 86400e3)
      : null,
  };
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const ACCOUNT = Number(flag("--account")) || 1;
  const SECRETS_FILE = flag("--secrets") || "secrets.json";
  const NO_VERIFY = args.includes("--no-verify");

  const r = await runExtract({ account: ACCOUNT, verify: !NO_VERIFY });
  if (!r.ok) {
    console.error("提取失败：" + r.reason);
    process.exit(1);
  }
  let secrets = {};
  try { secrets = JSON.parse(readFileSync(SECRETS_FILE, "utf8")); } catch {}
  Object.assign(secrets, r.secrets);
  writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2) + "\n");

  console.log(`\n已写入 ${SECRETS_FILE}（账号 ${ACCOUNT}）：`);
  console.log("  TRAE_DEVICE                设备密钥对与指纹（机器级，各账号共用）");
  console.log(`  TRAE_REFRESH_TOKEN${r.suffix.padEnd(13)}RefreshToken${r.days != null ? `（约剩 ${r.days} 天）` : ""}`);
  console.log(`  TRAE_REFRESH_EXPIRY${r.suffix.padEnd(12)}${r.expiry || "-"}`);
  if (r.label) console.log(`  TRAE_REFRESH_LABEL${r.suffix.padEnd(14)}${r.label}`);
  console.log(`\n下一步：npm run deploy（或 npm run secrets 只上传密钥）后，账号 ${ACCOUNT} 即用自动续期模式签到`);
  if (ACCOUNT === 1 && secrets.TRAE_SESSION)
    console.log(`注意：账号 1 已配置 TRAE_SESSION（Cookie 模式）。若上面显示的账号与其不同，请改用 --account N 写入其他编号`);
}
