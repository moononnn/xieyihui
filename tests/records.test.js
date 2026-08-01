import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addDebt,
  DEBT_MAX,
  DEBT_PER_SKIP,
  defaultRecords,
  loadRecords,
  markAchievementsViewed,
  saveRecords,
  settleEscape,
  settleRest,
  titleFor,
} from "../tools/_lib/records.js";

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xieyihui-records-test-"));
}

function baseEvent(overrides = {}) {
  return {
    windowId: "w-test",
    skips: 0,
    evades: 0,
    confiscates: 0,
    extraSeconds: 0,
    durationSec: 120,
    paidSeconds: 0,
    ...overrides,
  };
}

test("欠账每次跳过记 10 秒，封顶 120 秒", () => {
  const records = defaultRecords();
  assert.equal(addDebt(records, 1), DEBT_PER_SKIP);
  assert.equal(addDebt(records, 2), 30);
  addDebt(records, 99);
  assert.equal(records.debtSeconds, DEBT_MAX);
});

test("纯休息（无跳过）只计入总休息时长，不清欠账", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    records.debtSeconds = 30;
    const result = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 120, paidSeconds: 30 }), new Date("2026-07-31T10:00:00"));
    assert.equal(result.records.totalRestSec, 120);
    assert.equal(result.records.totalStruggleSec, 0);
    assert.equal(result.records.debtSeconds, 0); // 完成休息就还清欠账
    assert.equal(records.unlocked.first_rest, 0);
    assert.equal(records.unlocked.no_skip, 0);
    assert.equal(records.unlocked.debt_paid, 0); // 有欠账且完成 = 还清旧账
    // 新成就进入未查看队列
    assert.ok(records.newUnlocked.some((item) => item.id === "first_rest"));
    assert.ok(result.newAchievements.some((item) => item.id === "first_rest"));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("点过跳过的窗口：休息时长 = 总时长 - 搏斗时间（每次跳过 10 秒）", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    const result = settleRest(dataDir, "xieyihui", records, baseEvent({
      skips: 3,
      evades: 2,
      extraSeconds: 40,
      durationSec: 200,
      paidSeconds: 0,
    }), new Date("2026-07-31T10:00:00"));
    assert.equal(result.records.totalRestSec, 170); // 200 - 3×10
    assert.equal(result.records.totalStruggleSec, 30);
    assert.equal(result.records.totalExtraSec, 40);
    assert.equal(result.records.totalSkips, 3);
    assert.equal(records.unlocked.comeback, 0); // 跳过 >= 3 但完成
    assert.equal(records.unlocked.catch_me, 0); // 0.5.7 后按钮最多躲 2 次，2 次就解锁
    assert.equal(records.unlocked.stubborn, undefined); // 5 次才算顽固分子
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("躲不掉：按钮躲 2 次仍被你点到（修复：0.5.7 后划走上限为 2）", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    const result = settleRest(dataDir, "xieyihui", records, baseEvent({ skips: 1, evades: 1 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.unlocked.catch_me, undefined);
    assert.ok(!result.newAchievements.some((item) => item.id === "catch_me"));
    const records2 = defaultRecords();
    settleRest(dataDir, "xieyihui", records2, baseEvent({ skips: 1, evades: 2 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records2.unlocked.catch_me, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("顽固分子：单次跳过 5 次以上仍完成休息", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({ skips: 5, durationSec: 200 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.unlocked.stubborn, 0);
    assert.equal(records.unlocked.comeback, 0); // 3 次以上也同时解锁浪子回头
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("被没收还坚持：按钮被没收后仍完成休息", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({ confiscates: 1, skips: 1 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.unlocked.confiscated, 0);
    const records2 = defaultRecords();
    settleRest(dataDir, "xieyihui", records2, baseEvent({ skips: 1 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records2.unlocked.confiscated, undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("午间小憩：12~14 点完成休息解锁", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    const result = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-31T13:00:00"));
    assert.equal(records.unlocked.siesta, 0);
    assert.ok(result.newAchievements.some((item) => item.id === "siesta"));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("跳过次数很多时搏斗时间不超过窗口时长", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({
      skips: 20,
      durationSec: 100,
    }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.totalStruggleSec, 100);
    assert.equal(records.totalRestSec, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("逃逸窗口：欠账继续累计，搏斗时间按点击次数近似", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleEscape(dataDir, "xieyihui", records, baseEvent({ skips: 1, durationSec: 60, struggle: true }));
    assert.equal(records.debtSeconds, DEBT_PER_SKIP);
    assert.equal(records.totalSkips, 1);
    assert.equal(records.totalStruggleSec, 10); // 1 次跳过 × 10 秒
    assert.equal(records.completedCount, 0);
    assert.equal(records.unlocked.first_rest, undefined);
    assert.deepEqual(records.newUnlocked, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("连续三天完成休息解锁规律生活家·黄铜", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-29T10:00:00"));
    settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-30T10:00:00"));
    const result = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.streakDays, 3);
    assert.equal(records.unlocked.streak, 0);
    assert.ok(result.newAchievements.some((item) => item.id === "streak" && item.level === 0));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("中断一天后连续天数重置", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-29T10:00:00"));
    settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.streakDays, 1);
    assert.equal(records.unlocked.streak, undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("阶段成就：茶歇爱好者按累计时长升级（黄铜→白银→黄金→白金）", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    // 累计 1800 秒 → 黄铜
    for (let i = 0; i < 18; i += 1) {
      settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 100 }), new Date(`2026-06-${String((i % 28) + 1).padStart(2, "0")}T10:00:00`));
    }
    assert.equal(records.unlocked.rest_total, 0);
    // 累计 7200 秒 → 白银
    for (let i = 0; i < 54; i += 1) {
      settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 100 }), new Date(`2026-06-${String((i % 28) + 1).padStart(2, "0")}T10:00:00`));
    }
    assert.equal(records.unlocked.rest_total, 1);
    // 同一等级内再完成：不重复解锁提示
    const again = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 100 }), new Date("2026-07-01T10:00:00"));
    assert.equal(again.newAchievements.some((item) => item.id === "rest_total"), false);
    // 直接构造高累计验证黄金/白金等级判定
    records.totalRestSec = 28800;
    const gold = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 100 }), new Date("2026-07-02T10:00:00"));
    assert.equal(records.unlocked.rest_total, 2);
    assert.ok(gold.newAchievements.some((item) => item.id === "rest_total" && item.level === 2 && item.tierName === "黄金"));
    records.totalRestSec = 86400;
    const plat = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 100 }), new Date("2026-07-03T10:00:00"));
    assert.equal(records.unlocked.rest_total, 3);
    assert.ok(plat.newAchievements.some((item) => item.id === "rest_total" && item.tierName === "白金"));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("阶段成就：未达门槛不解锁，达标记录等级", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 100 }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.unlocked.rest_total, undefined); // 100 秒 < 1800
    assert.equal(records.unlocked.rest_count, undefined); // 1 次 < 5 次
    assert.equal(records.unlocked.extra_total, undefined);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("凌晨完成休息解锁夜猫子落网", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    const result = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-31T03:30:00"));
    assert.equal(result.records.unlocked.night_owl, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("累计跳过 10 次解锁金手指（逃逸与完成都计入）", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    for (let i = 0; i < 9; i += 1) {
      settleEscape(dataDir, "xieyihui", records, baseEvent({ skips: 1, durationSec: 10, struggle: true }));
    }
    settleRest(dataDir, "xieyihui", records, baseEvent({ skips: 1, durationSec: 10, struggle: true }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.totalSkips, 10);
    assert.equal(records.unlocked.golden_finger, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("成就不会重复解锁，称号按解锁数量升级", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-31T10:00:00"));
    const before = Object.keys(records.unlocked).length;
    const result = settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-08-01T10:00:00"));
    assert.equal(Object.keys(result.records.unlocked).length, before); // 第二次完成不重复解锁
    assert.equal(titleFor(records).name, "开始爱自己"); // 2 个以上成就
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("旧格式成就数组自动迁移为对象", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    records.unlocked = ["first_rest", "no_skip"]; // 模拟旧版本数据
    saveRecords(dataDir, "xieyihui", records);
    const loaded = loadRecords(dataDir, "xieyihui");
    assert.deepEqual(loaded.unlocked, { first_rest: 0, no_skip: 0 });
    assert.deepEqual(loaded.newUnlocked, []);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("新成就进入未查看队列，查看后清空并持久化", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleRest(dataDir, "xieyihui", records, baseEvent({ durationSec: 10 }), new Date("2026-07-31T10:00:00"));
    assert.ok(records.newUnlocked.some((item) => item.id === "first_rest"));
    markAchievementsViewed(dataDir, "xieyihui", records);
    assert.deepEqual(records.newUnlocked, []);
    const loaded = loadRecords(dataDir, "xieyihui");
    assert.deepEqual(loaded.newUnlocked, []);
    assert.equal(loaded.unlocked.first_rest, 0); // 已解锁成就不丢
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("记录持久化：保存后能重新读回", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    settleEscape(dataDir, "xieyihui", records, baseEvent({ skips: 2, durationSec: 30, struggle: true }));
    const loaded = loadRecords(dataDir, "xieyihui");
    assert.equal(loaded.debtSeconds, 20);
    assert.equal(loaded.totalSkips, 2);
    assert.equal(loaded.totalStruggleSec, 20);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("补还欠账计入加时时长", () => {
  const dataDir = makeDataDir();
  try {
    const records = defaultRecords();
    records.debtSeconds = 50;
    settleRest(dataDir, "xieyihui", records, baseEvent({
      durationSec: 170,
      extraSeconds: 20,
      paidSeconds: 50,
    }), new Date("2026-07-31T10:00:00"));
    assert.equal(records.totalExtraSec, 70);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
