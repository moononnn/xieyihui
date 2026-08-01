import test from "node:test";
import assert from "node:assert/strict";
import { shouldPause } from "../tools/_lib/timer.js";

const baseConfig = {
  pauseOnFullscreen: true,
  pauseOnAway: true,
  awayThresholdMinutes: 5,
};

const baseEnv = {
  fullscreen: false,
  dnd: false,
  idleSeconds: 0,
  checkedAt: 0,
};

test("全屏时暂停：开关打开且前台全屏 → fullscreen", () => {
  assert.equal(shouldPause(baseConfig, { ...baseEnv, fullscreen: true }), "fullscreen");
});

test("全屏时暂停：开关关闭则不暂停", () => {
  const config = { ...baseConfig, pauseOnFullscreen: false };
  assert.equal(shouldPause(config, { ...baseEnv, fullscreen: true }), null);
});

test("暂离暂停：空闲时间达到阈值 → away", () => {
  assert.equal(shouldPause(baseConfig, { ...baseEnv, idleSeconds: 300 }), "away");
});

test("暂离暂停：空闲时间未达阈值不暂停", () => {
  assert.equal(shouldPause(baseConfig, { ...baseEnv, idleSeconds: 299 }), null);
  assert.equal(shouldPause(baseConfig, { ...baseEnv, idleSeconds: 0 }), null);
});

test("暂离暂停：恰好等于阈值（5 分钟 = 300 秒）命中", () => {
  assert.equal(shouldPause(baseConfig, { ...baseEnv, idleSeconds: 300 }), "away");
});

test("暂离暂停：开关关闭则即使超时也不暂停", () => {
  const config = { ...baseConfig, pauseOnAway: false };
  assert.equal(shouldPause(config, { ...baseEnv, idleSeconds: 99999 }), null);
});

test("暂离暂停：阈值为 0 或非法值时不暂停（配置异常保护）", () => {
  assert.equal(shouldPause({ ...baseConfig, awayThresholdMinutes: 0 }, { ...baseEnv, idleSeconds: 300 }), null);
  assert.equal(shouldPause({ ...baseConfig, awayThresholdMinutes: -1 }, { ...baseEnv, idleSeconds: 300 }), null);
  assert.equal(shouldPause({ ...baseConfig, awayThresholdMinutes: "abc" }, { ...baseEnv, idleSeconds: 300 }), null);
});

test("免打扰：无条件暂停，即使两个开关都关", () => {
  const config = { ...baseConfig, pauseOnFullscreen: false, pauseOnAway: false };
  assert.equal(shouldPause(config, { ...baseEnv, dnd: true }), "dnd");
});

test("正常环境不暂停", () => {
  assert.equal(shouldPause(baseConfig, baseEnv), null);
});

test("空配置或空环境返回 null（防御）", () => {
  assert.equal(shouldPause(null, baseEnv), null);
  assert.equal(shouldPause(baseConfig, null), null);
});
