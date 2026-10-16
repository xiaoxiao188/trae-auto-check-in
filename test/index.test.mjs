import { test } from "node:test";
import assert from "node:assert/strict";
import { retryCronList, cronToBj, retrySkipReason } from "../src/index.js";

test("retryCronList：解析 RETRY_CRONS 变量", () => {
  assert.deepEqual(retryCronList({ RETRY_CRONS: '["25 2 * * *","55 2 * * *"]' }), [
    "25 2 * * *",
    "55 2 * * *",
  ]);
  assert.deepEqual(retryCronList({}), []); // 未配置（旧部署）视为主签到轮
  assert.deepEqual(retryCronList({ RETRY_CRONS: "not json" }), []);
  assert.deepEqual(retryCronList({ RETRY_CRONS: '"str"' }), []); // 非数组
  assert.deepEqual(retryCronList({ RETRY_CRONS: '[1, "25 2 * * *"]' }), [
    "25 2 * * *",
  ]); // 过滤非字符串
});

test("cronToBj：UTC cron → 北京时间", () => {
  assert.equal(cronToBj("05 2 * * *"), "10:05");
  assert.equal(cronToBj("25 3 * * *"), "11:25");
  assert.equal(cronToBj("0 16 * * *"), "00:00"); // 跨日
  assert.equal(cronToBj("*/5 * * * *"), null);
  assert.equal(cronToBj(undefined), null);
});

test("retrySkipReason：主轮永远推送", () => {
  assert.equal(retrySkipReason([], 0, 3), null);
  assert.equal(retrySkipReason([{ ok: false }], 0, 3), null);
});

test("retrySkipReason：无可重试账号不推送", () => {
  const reason = retrySkipReason([], 1, 3);
  assert.match(reason, /第 1\/3 次重试：全部账号已签到或凭证失效/);
});

test("retrySkipReason：中间轮无补签成功不推送", () => {
  const reason = retrySkipReason([{ ok: false, already: false }], 1, 3);
  assert.match(reason, /仍失败，不推送/);
  // 「已签到」结果只在主轮出现，不算补签成功
  assert.match(
    retrySkipReason([{ ok: true, already: true }], 2, 3),
    /仍失败，不推送/
  );
});

test("retrySkipReason：补签成功或最后一轮照常推送", () => {
  assert.equal(retrySkipReason([{ ok: true, already: false }], 1, 3), null);
  assert.equal(retrySkipReason([{ ok: false }], 3, 3), null);
  assert.equal(
    retrySkipReason([{ ok: true, already: false }, { ok: false }], 2, 3),
    null
  );
});
