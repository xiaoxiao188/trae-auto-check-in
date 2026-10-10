import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  cronToBeijing,
  beijingToCron,
  applyCron,
  createAsker,
  collectChanges,
} from "../deploy.mjs";

test("cronToBeijing：UTC → 北京时间", () => {
  assert.equal(cronToBeijing("05 2 * * *"), "10:05");
  assert.equal(cronToBeijing("30 0 * * *"), "08:30");
  assert.equal(cronToBeijing("0 16 * * *"), "00:00"); // 跨日：UTC 16 点 = 北京次日 0 点
  assert.equal(cronToBeijing("0 0 1 1 *"), null); // 非每日定时
  assert.equal(cronToBeijing("abc"), null);
});

test("beijingToCron：北京时间 → UTC", () => {
  assert.equal(beijingToCron("10:05"), "05 2 * * *");
  assert.equal(beijingToCron("08:30"), "30 0 * * *");
  assert.equal(beijingToCron("00:00"), "00 16 * * *"); // 跨日：北京 0 点 = UTC 前日 16 点
  assert.equal(beijingToCron("24:00"), null);
  assert.equal(beijingToCron("ab:cd"), null);
});

test("cron 双向转换往返一致", () => {
  for (const t of ["00:00", "08:30", "10:05", "23:59"]) {
    assert.equal(cronToBeijing(beijingToCron(t)), t);
  }
});

test("applyCron：更新 crons 行并同步注释", () => {
  const toml = `# 每日北京时间 10:05 触发 = UTC 02:05，错开签到高峰\n[triggers]\ncrons = ["05 2 * * *"]\n`;
  const out = applyCron(toml, "30 0 * * *");
  assert.match(out, /crons = \["30 0 \* \* \*"\]/);
  assert.match(out, /# 每日北京时间 08:30 触发 = UTC 00:30/);
});

test("applyCron：找不到 crons 配置返回 null", () => {
  assert.equal(applyCron('name = "trae-checkin"\n', "0 0 * * *"), null);
});

test("createAsker：行排队与流结束后视为回车", async () => {
  const rl = new EventEmitter();
  const ask = createAsker(rl);
  const p1 = ask("q1: ");
  const p2 = ask("q2: ");
  rl.emit("line", "a1");
  rl.emit("line", "a2");
  assert.equal(await p1, "a1");
  assert.equal(await p2, "a2");
  rl.emit("close");
  assert.equal(await ask("q3: "), "");
});

test("collectChanges：全部回车沿用现有值", async () => {
  const secrets = { TRAE_SESSION: "s1" };
  const res = await collectChanges(async () => "", secrets, "05 2 * * *");
  assert.equal(res.confirmed, true);
  assert.deepEqual(res.changed, []);
  assert.equal(res.newCron, "05 2 * * *");
  assert.deepEqual(secrets, { TRAE_SESSION: "s1" });
});

test("collectChanges：输入新密钥与新触发时间", async () => {
  const secrets = { TRAE_SESSION: "old" };
  // 5 个密钥项 + 触发时间 + 最终确认
  const answers = ["new-session", "", "", "", "", "08:30", ""];
  const res = await collectChanges(() => answers.shift(), secrets, "05 2 * * *");
  assert.equal(res.confirmed, true);
  assert.deepEqual(res.changed, ["TRAE_SESSION"]);
  assert.equal(res.newCron, "30 0 * * *");
  assert.equal(secrets.TRAE_SESSION, "new-session");
});
