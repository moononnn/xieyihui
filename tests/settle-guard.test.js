import test from "node:test";
import assert from "node:assert/strict";
import { restartTick, shouldSettleWindow, stop } from "../tools/_lib/timer.js";
import { state, STATES } from "../tools/_lib/state.js";

// ─── 结算幂等（纯函数） ───────────────────────────

test("shouldSettleWindow：空窗口 ID 不判重（历史兜底行为）", () => {
  const settled = new Set(["w-1"]);
  assert.equal(shouldSettleWindow("", settled), true);
  assert.equal(shouldSettleWindow(null, settled), true);
  assert.equal(shouldSettleWindow(undefined, settled), true);
});

test("shouldSettleWindow：不在已结算集合中 → 需要结算", () => {
  const settled = new Set(["w-1"]);
  assert.equal(shouldSettleWindow("w-2", settled), true);
  assert.equal(shouldSettleWindow("w-2", new Set()), true);
});

test("shouldSettleWindow：已在已结算集合中 → 跳过结算", () => {
  const settled = new Set(["w-1", "w-2"]);
  assert.equal(shouldSettleWindow("w-1", settled), false);
  assert.equal(shouldSettleWindow("w-2", settled), false);
});

// ─── 休息中保存配置不重置工作计时 ─────────────────

test("restartTick：休息中（BREAKING）保存配置不重置阶段，不提前开始工作计时", () => {
  state.config = { ...state.config, enableBreaks: true };
  state.phase = STATES.BREAKING;
  restartTick();
  assert.equal(state.phase, STATES.BREAKING, "休息窗口开着时不能切回工作中");
  // 清理：恢复暂停态，避免遗留定时器
  state.config = { ...state.config, enableBreaks: false };
  restartTick();
  assert.equal(state.phase, STATES.IDLE);
});

test("restartTick：非休息中保存配置照常回到工作中并计时", () => {
  state.config = { ...state.config, enableBreaks: true };
  state.phase = STATES.WORKING;
  restartTick();
  assert.equal(state.phase, STATES.WORKING);
  stop();
  state.config = { ...state.config, enableBreaks: false };
});
