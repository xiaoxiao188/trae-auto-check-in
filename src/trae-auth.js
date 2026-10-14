// Trae 凭证续期核心（Node 与 Cloudflare Workers 双端通用，只用 WebCrypto + fetch）。
// 逆向自 Trae 客户端与社区项目（qilimixingkong/trae-checkin、magpie#808）：
// 用本地提取的 RefreshToken + 设备 ECDSA P-256 密钥对调 /trae/api/v3/oauth/ExchangeToken
// 换取绑定了设备的 JWT，签到 claim 接口只认这种 token（不带设备证明的会被 9074 风控拒绝）。
// 实测：该接口返回新 RefreshToken 但不轮换作废旧值 → Worker 只需保存提取时的一份即可。

export const BASE = "https://api.trae.cn";
export const EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";

// 仿客户端 UA：非真实客户端 UA 会被判为脚本（magpie#808 实测 9074），续期模式下统一使用
export const REFRESH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "TRAE-SOLO-CN/0.1.64 Chrome/120.0.0.0 Electron/28.2.10 Safari/537.36";

// 两套客户端参数组（逆向自客户端 main.js 的 L2/Rr 函数）。RefreshToken 绑定签发它的客户端：
// 从 Trae CN 登录拿的 token 只认 trae 组，从 TRAE SOLO CN 拿的只认 solo 组，故按来源记录、失败互换重试
export const CLIENT_PARAMS = {
  trae: { clientId: "ono9krqynydwx5", platformCode: "IDE_PC", clientVersion: "3.3.99" },
  solo: { clientId: "en1oxy7wnw8j9n", platformCode: "SOLO_PC", clientVersion: "0.1.64" },
};

// storage.json 密文的两组内置常量（客户端 main.js 固化，两客户端逐字节一致）
const _OE = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
  124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
  84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
  8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37];
const _MOE = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
  96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
  160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
  23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];
const SALT = Uint8Array.from(_OE.map((v, i) => v ^ _MOE[i]));
// 导出供单元测试构造往返加密密文用
export { SALT };

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// 解密 storage.json 里的凭证密文（base64 → [6B 头][32B 内嵌密钥 K][AES-128-CBC 密文]，
// AES 密钥/IV 由 SHA512(K) 与内置 SALT 派生，明文去掉前 64B SHA512 校验后即 JSON）
export async function decryptAuthBlob(b64) {
  const blob = b64ToBytes(b64);
  const head = [116, 99, 5, 16, 0, 0];
  if (blob.length < 38 || !head.every((v, i) => blob[i] === v))
    throw new Error("密文头部不符合预期（Trae 客户端可能已更新加密方案）");
  const n = new Uint8Array(128);
  n.set(new Uint8Array(await crypto.subtle.digest("SHA-512", blob.slice(6, 38))), 0);
  n.set(SALT, 64);
  n.set(new Uint8Array(await crypto.subtle.digest("SHA-512", n)), 0);
  const key = await crypto.subtle.importKey("raw", n.slice(0, 16), "AES-CBC", false, ["decrypt"]);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv: n.slice(16, 32) }, key, blob.slice(38))
  );
  return JSON.parse(new TextDecoder().decode(pt.slice(64)));
}

// PEM → DER 字节（WebCrypto importKey 只吃 DER）
export function pemToDer(pem) {
  return b64ToBytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
}

// WebCrypto 的 ECDSA 签名是裸 r||s（64B），服务端要 DER 格式（与 Python/Node crypto.sign 一致）
export function rawSigToDer(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let b = bytes.slice(i);
    if (b[0] & 0x80) b = new Uint8Array([0, ...b]);
    return [0x02, b.length, ...b];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

// DeviceInfo 必须用提取时捕获的本机真实值（服务端校验设备指纹与密钥配对，凭空编造会被拒）
function buildDeviceInfo(device, params) {
  return {
    DeviceID: device.DeviceID,
    MachineID: device.MachineID,
    PlatformCode: params.platformCode,
    DeviceType: "PC",
    DeviceName: device.DeviceName,
    DeviceModel: "",
    ClientVersion: params.clientVersion,
    DevicePublicKey: device.DevicePublicKey,
    DeviceBrand: "",
    DeviceCPU: "",
    OSInfo: device.OSInfo || "Windows",
    OSVersion: device.OSVersion,
  };
}

// 用 RefreshToken 换新 JWT。网络异常或 5xx 重试 3 次（与 Worker 的 post 策略一致）；
// 返回 { ok:true, token, refreshExpireAt } 或 { ok:false, code, error }
export async function exchangeToken({ refreshToken, device, params }) {
  let lastError = "未知错误";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ts = Math.floor(Date.now() / 1000);
      const rand = new Uint8Array(16);
      crypto.getRandomValues(rand);
      const nonce = [...rand].map((b) => b.toString(16).padStart(2, "0")).join("");
      const msg = ["POST", EXCHANGE_PATH, params.clientId, refreshToken, String(ts), nonce].join("\n");
      const key = await crypto.subtle.importKey(
        "pkcs8", pemToDer(device.PrivateKey),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
      );
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(msg))
      );
      const sig = btoa(String.fromCharCode(...rawSigToDer(raw)));
      const resp = await fetch(BASE + EXCHANGE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ClientID: params.clientId,
          ClientSecret: "",
          RefreshToken: refreshToken,
          DeviceInfo: buildDeviceInfo(device, params),
          DeviceProof: { Signature: sig, Timestamp: ts, Nonce: nonce },
          IDEVersion: params.clientVersion,
        }),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (json?.Result?.Token)
        return { ok: true, token: json.Result.Token, refreshExpireAt: json.Result.RefreshExpireAt };
      const err = json?.ResponseMetadata?.Error;
      // 4xx 是业务错误不重试；仅网络异常与 5xx 重试
      if (resp.status < 500)
        return { ok: false, code: err?.Code ?? resp.status, error: err?.Message || `HTTP ${resp.status} ${text.slice(0, 120)}` };
      lastError = `HTTP ${resp.status}`;
    } catch (e) {
      lastError = e.message;
    }
  }
  return { ok: false, code: null, error: "ExchangeToken 网络重试耗尽: " + lastError };
}

// 按设备记录的客户端参数组续期，失败时换另一组重试（参数组标错可自愈）。
// 返回 { ok:true, token, clientType } / { ok:false, code, error }
export async function renewToken(refreshToken, device) {
  const primary = CLIENT_PARAMS[device.ClientType] ? device.ClientType : "trae";
  const order = primary === "trae" ? ["trae", "solo"] : ["solo", "trae"];
  let last = { ok: false, error: "未知错误" };
  for (const type of order) {
    const r = await exchangeToken({ refreshToken, device, params: CLIENT_PARAMS[type] });
    if (r.ok) return { ...r, clientType: type };
    last = r;
  }
  return last;
}
