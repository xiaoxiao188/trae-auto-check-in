import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import {
  SALT,
  decryptAuthBlob,
  pemToDer,
  rawSigToDer,
  CLIENT_PARAMS,
} from "../src/trae-auth.js";
import { iterAccounts, buildFeishuCard } from "../src/index.js";

// 按逆向出的算法构造加密密文（decryptAuthBlob 的逆），用于往返测试
function encryptAuthBlob(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const K = crypto.randomBytes(32);
  const n = Buffer.alloc(128);
  crypto.createHash("sha512").update(K).digest().copy(n, 0, 0, 64);
  Buffer.from(SALT).copy(n, 64);
  crypto.createHash("sha512").update(n).digest().copy(n, 0, 0, 64);
  const cipher = crypto.createCipheriv("aes-128-cbc", n.subarray(0, 16), n.subarray(16, 32));
  const pt = Buffer.concat([
    crypto.createHash("sha512").update(payload).digest(),
    payload,
  ]);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([Buffer.from([116, 99, 5, 16, 0, 0]), K, ct]).toString("base64");
}

test("decryptAuthBlob：加密往返解出原对象", async () => {
  const obj = {
    token: "tok",
    refreshToken: "rt-abc",
    refreshExpiredAt: "2027-04-03T19:39:39.338Z",
    userId: 115921811418552,
    account: { username: "stars", nonPlainTextMobile: "175******08" },
  };
  assert.deepEqual(await decryptAuthBlob(encryptAuthBlob(obj)), obj);
});

test("decryptAuthBlob：头部不符报错", async () => {
  await assert.rejects(() => decryptAuthBlob(Buffer.from("garbage!!").toString("base64")), /密文头部/);
});

test("rawSigToDer：WebCrypto 签名转 DER 后可被标准验证器验签", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const msg = Buffer.from(
    "POST\n/trae/api/v3/oauth/ExchangeToken\nono9krqynydwx5\nrefresh-token\n1790000000\n0123abcd"
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, msg));
  const der = rawSigToDer(raw);
  // 服务端按标准 DER 验签：用 Node 的验签器等价验证转换正确
  assert.equal(der[0], 0x30);
  assert.ok(
    crypto.createVerify("SHA256").update(msg).verify(publicKey, Buffer.from(der))
  );
});

test("rawSigToDer：高位整数补零与去前导零", () => {
  // r 末两字节 0xff 01（高位置 1，编码需补 0x00）；s 前部全零（需去除前导零）
  const raw = new Uint8Array(64);
  raw.set([0xff, 0x01], 30);
  raw.set([0x00, 0x00, 0x02, 0x03], 60);
  const der = rawSigToDer(raw);
  assert.deepEqual([...der], [0x30, 9, 0x02, 3, 0x00, 0xff, 0x01, 0x02, 2, 0x02, 0x03]);
});

test("pemToDer：与 Node 原生 DER 导出一致", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.deepEqual(
    Buffer.from(pemToDer(pem)),
    publicKey.export({ type: "spki", format: "der" })
  );
});

test("CLIENT_PARAMS：两组参数齐备", () => {
  assert.equal(CLIENT_PARAMS.trae.clientId, "ono9krqynydwx5");
  assert.equal(CLIENT_PARAMS.trae.platformCode, "IDE_PC");
  assert.equal(CLIENT_PARAMS.solo.clientId, "en1oxy7wnw8j9n");
  assert.equal(CLIENT_PARAMS.solo.platformCode, "SOLO_PC");
});

test("iterAccounts：纯续期账号（无 Cookie）也被识别", () => {
  const { accounts, gaps } = iterAccounts({ TRAE_REFRESH_TOKEN: "rt" });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].refreshToken, "rt");
  assert.equal(accounts[0].session, "");
  assert.deepEqual(gaps, []);
});

test("iterAccounts：两种凭证共存时同一编号只算一个账号", () => {
  const { accounts } = iterAccounts({
    TRAE_SESSION: "s1",
    TRAE_REFRESH_TOKEN: "rt1",
    TRAE_SESSION_3: "s3",
    TRAE_REFRESH_TOKEN_3: "rt3",
  });
  assert.deepEqual(accounts.map((a) => a.name), ["账号 1", "账号 3"]);
  assert.equal(accounts[0].refreshExpiry, "");
  const withExpiry = iterAccounts({
    TRAE_SESSION: "s1",
    TRAE_REFRESH_TOKEN: "rt1",
    TRAE_REFRESH_EXPIRY: "2027-04-03",
    TRAE_REFRESH_LABEL: "stars 175******08",
    TRAE_SESSION_DATE: "2026-10-09",
  });
  assert.equal(withExpiry.accounts[0].refreshExpiry, "2027-04-03");
  assert.equal(withExpiry.accounts[0].refreshLabel, "stars 175******08");
  assert.equal(withExpiry.accounts[0].sessionDate, "2026-10-09");
  // 中间断号仍记入 gaps
  assert.deepEqual(iterAccounts({ TRAE_SESSION: "s", TRAE_SESSION_3: "s3" }).gaps, [2]);
});

test("buildFeishuCard：标题进 header、时间进 note、标签加粗状态着色", () => {
  const lines = [
    "Trae 自动签到",
    "账号：stars 175******08",
    "签到结果：✅ 成功",
    "签到积分：+150",
    "通用积分：4825.49",
    "会话有效期：约剩 9 天",
    "签到时间：2026-10-14 10:05:05",
  ];
  const card = buildFeishuCard(lines);
  assert.equal(card.header.title.content, "Trae 自动签到");
  assert.equal(card.header.template, "green"); // 全成功 → 绿
  const md = card.elements[0].text.content;
  assert.ok(md.includes("**账号：**stars 175******08"));
  assert.ok(md.includes("<font color='green'>✅ 成功</font>"));
  assert.ok(!md.includes("签到时间")); // 时间不进正文
  assert.equal(
    card.elements[2].elements[0].content,
    "签到时间：2026-10-14 10:05:05"
  );
  // 多账号空行保留为段落间距
  assert.ok(
    buildFeishuCard(["t", "账号：A", "", "账号：B", "时间：x"]).elements[0].text.content.includes("\n\n")
  );
});

test("buildFeishuCard：含失败标题栏红色、含警告橙色", () => {
  assert.equal(
    buildFeishuCard(["t", "签到结果：❌ 失败（x）", "时间：x"]).header.template,
    "red"
  );
  assert.equal(
    buildFeishuCard(["t", "⚠️ 编号 2 的账号凭证缺失", "时间：x"]).header.template,
    "orange"
  );
  // 失败 + 警告并存 → 红色优先
  assert.equal(
    buildFeishuCard(["t", "⚠️ 提醒", "签到结果：❌ 失败", "时间：x"]).header.template,
    "red"
  );
  // 失败值着红
  const md = buildFeishuCard(["t", "签到结果：❌ 失败（原因）", "时间：x"]).elements[0].text.content;
  assert.ok(md.includes("<font color='red'>❌ 失败（原因）</font>"));
});
