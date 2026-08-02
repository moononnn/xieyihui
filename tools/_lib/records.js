// 歇一会 - 记录模块：欠账、统计、成就与称号
// 所有数据持久化在 插件数据目录/records.json，跨休息窗口生效。

import fs from "node:fs";
import path from "node:path";
import { createRoundRobin, PRAISE_REPLIES } from "./replies.js";
import { readJsonSafe, writeJsonAtomic } from "./fsutil.js";

const RECORDS_FILE = "records.json";
export const DEBT_PER_SKIP = 10;      // 每次点跳过记 10 秒欠账
export const DEBT_MAX = 120;          // 总欠账上限 120 秒
export const STRUGGLE_PER_SKIP = 10;  // 每次点跳过近似 10 秒“搏斗时间”
export const STREAK_BONUS_SECONDS = 5; // 连续休息的奖励（暂未启用，保留扩展位）

// 阶段成就的级别名：黄铜 → 白金
export const TIER_NAMES = ["黄铜", "白银", "黄金", "白金"];

export const TITLES = [
  { count: 0, name: "还在学习休息" },
  { count: 2, name: "开始爱自己" },
  { count: 4, name: "懂得休息的人" },
  { count: 7, name: "休息大师" },
  { count: 10, name: "把休息当回事的人" },
  { count: 14, name: "身心合一" },
];

/**
 * 成就定义：
 * - tier: "once" 一次性（test 返回 bool）；"tiered" 阶段成就（levels 四级，progress 返回累计值）
 * - 阶段成就解锁任一等级后 records.unlocked[id] = 当前最高等级 index；升级也产生新成就提示
 */
export const ACHIEVEMENTS = [
  // ── 一次性成就（行为类） ──
  {
    id: "first_rest",
    name: "迈出第一步",
    icon: "seedling",
    tier: "once",
    desc: "完成第一次完整休息",
    praise: "第一次完整休息达成。身体和心都记下了这份好。",
    test: (event, records) => records.completedCount >= 1,
  },
  {
    id: "no_skip",
    name: "稳住不逃",
    icon: "shield",
    tier: "once",
    desc: "一次休息全程没点跳过",
    praise: "全程没碰跳过按钮，这份定力值得表扬。",
    test: (event) => event.completed && event.skips === 0,
  },
  {
    id: "comeback",
    name: "浪子回头",
    icon: "return",
    tier: "once",
    desc: "单次点跳过 3 次以上，最终仍完成休息",
    praise: "跟我斗了这么多回合，最后还是好好休息了。欣慰。",
    test: (event) => event.completed && event.skips >= 3,
  },
  {
    id: "catch_me",
    name: "躲不掉",
    icon: "target",
    tier: "once",
    desc: "按钮躲了 2 次还是被你点到",
    praise: "按钮躲了你两次都没躲掉，这手速不点跳过可惜了……不对，不可惜。",
    test: (event) => event.completed && event.evades >= 2,
  },
  {
    id: "debt_paid",
    name: "还清旧账",
    icon: "book",
    tier: "once",
    desc: "把上次欠的休息时间一次还清",
    praise: "欠的休息时间还清了，好孩子。账本从此翻篇。",
    test: (event) => event.completed && event.paidSeconds > 0,
  },
  {
    id: "night_owl",
    name: "夜猫子落网",
    icon: "moon",
    tier: "once",
    desc: "凌晨 0~6 点之间完成休息",
    praise: "这个点还被我逮着休息，算你识相。睡吧。",
    test: (event) => event.completed && event.hour >= 0 && event.hour < 6,
  },
  {
    id: "siesta",
    name: "午间小憩",
    icon: "sun",
    tier: "once",
    desc: "中午 12~14 点之间完成休息",
    praise: "午休充好电，下午才不会蔫。这一觉睡得值。",
    test: (event) => event.completed && event.hour >= 12 && event.hour < 14,
  },
  {
    id: "golden_finger",
    name: "金手指",
    icon: "trophy",
    tier: "once",
    desc: "累计点跳过 10 次",
    praise: "金手指？是逃避十连击。账我都记着呢。",
    test: (event, records) => records.totalSkips >= 10,
  },
  {
    id: "stubborn",
    name: "顽固分子",
    icon: "alert",
    tier: "once",
    desc: "单次点跳过 5 次以上，最终仍完成休息",
    praise: "连点五次还完成了休息……你是嘴硬，不是身体硬。也算厉害。",
    test: (event) => event.completed && event.skips >= 5,
  },
  {
    id: "confiscated",
    name: "被没收还坚持",
    icon: "lock",
    tier: "once",
    desc: "按钮被没收后，仍完成这次休息",
    praise: "按钮都没了还坚持把休息守完，这份配合度我给满分。",
    test: (event) => event.completed && event.confiscates > 0,
  },

  // ── 阶段成就（黄铜 / 白银 / 黄金 / 白金） ──
  // icons：四级图标变体（细节随等级丰富），unit：进度单位（秒/次/天）
  {
    id: "rest_total",
    name: "茶歇爱好者",
    icons: ["cup-0", "cup-1", "cup-2", "cup-3"],
    unit: "秒",
    tier: "tiered",
    desc: "累计休息时长",
    progress: (records) => records.totalRestSec,
    levels: [
      { threshold: 1800, title: "初尝茶歇", praise: "累计休息半小时，身体开始回血了。" },
      { threshold: 7200, title: "茶歇常客", praise: "累计休息两小时，这杯茶歇得很值。" },
      { threshold: 28800, title: "茶歇大师", praise: "累计八小时，你已经把休息喝成了习惯。" },
      { threshold: 86400, title: "茶歇仙人", praise: "累计一整天。茶歇爱好者，白金认证。" },
    ],
  },
  {
    id: "rest_count",
    name: "休息标兵",
    icons: ["flag-0", "flag-1", "flag-2", "flag-3"],
    unit: "次",
    tier: "tiered",
    desc: "累计完成完整休息的次数",
    progress: (records) => records.completedCount,
    levels: [
      { threshold: 5, title: "休息新兵", praise: "完成五次完整休息，规律正在养成。" },
      { threshold: 10, title: "休息能手", praise: "十次完整休息，你的身体记得每一个好习惯。" },
      { threshold: 50, title: "休息专家", praise: "五十次。休息标兵，名副其实。" },
      { threshold: 100, title: "休息传奇", praise: "一百次完整休息，这是你写给身体的信。" },
    ],
  },
  {
    id: "streak",
    name: "规律生活家",
    icons: ["calendar-0", "calendar-1", "calendar-2", "calendar-3"],
    unit: "天",
    tier: "tiered",
    desc: "连续完成休息的天数",
    progress: (records) => records.streakDays,
    levels: [
      { threshold: 3, title: "初见规律", praise: "连续三天好好休息，习惯正在长成。" },
      { threshold: 7, title: "一周骑士", praise: "连续一周。身体已经认得你的作息了。" },
      { threshold: 14, title: "习惯成自然", praise: "连续两周，雷打不动的休息节奏。" },
      { threshold: 30, title: "雷打不动", praise: "连续三十天。你已经是休息界的劳模。" },
    ],
  },
  {
    id: "extra_total",
    name: "铁打的休息",
    icons: ["hourglass-0", "hourglass-1", "hourglass-2", "hourglass-3"],
    unit: "秒",
    tier: "tiered",
    desc: "累计被加时的时长（跳过越狠，勋章越亮）",
    progress: (records) => records.totalExtraSec,
    levels: [
      { threshold: 60, title: "初犯在案", praise: "被加时一分钟。这笔账，身体帮你记着。" },
      { threshold: 600, title: "惯犯档案", praise: "被加时十分钟。你逃得越欢，我留你越久。" },
      { threshold: 1800, title: "逃逸大师", praise: "被加时半小时。铁打的休息，流水的跳过。" },
      { threshold: 3600, title: "牢底坐穿", praise: "被加时一小时。这个勋章，是你和我的共同作品。" },
    ],
  },
];

export const ACHIEVEMENT_MAP = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

function recordsPath(dataDir, pluginId) {
  return path.join(dataDir, pluginId, RECORDS_FILE);
}

export function defaultRecords() {
  return {
    debtSeconds: 0,
    totalRestSec: 0,
    totalExtraSec: 0,
    totalStruggleSec: 0,
    totalSkips: 0,
    completedCount: 0,
    unlocked: {},        // { 成就id: 等级 }，一次性成就等级恒为 0
    newUnlocked: [],     // 未查看的新成就 [{ id, level }]，查看后清空
    streakDays: 0,
    lastRestDate: "",
  };
}

export function loadRecords(dataDir, pluginId) {
  const parsed = readJsonSafe(recordsPath(dataDir, pluginId));
  if (parsed === undefined) return defaultRecords();
  const base = { ...defaultRecords(), ...parsed };
    // 成就数据迁移：旧格式数组 → 对象 { id: level }（一次性成就 level=0）
    if (Array.isArray(parsed.unlocked)) {
      base.unlocked = Object.fromEntries(parsed.unlocked.filter(Boolean).map((id) => [id, 0]));
    } else if (!parsed.unlocked || typeof parsed.unlocked !== "object") {
      base.unlocked = {};
    }
    base.newUnlocked = Array.isArray(parsed.newUnlocked) ? parsed.newUnlocked : [];
    return base;
}

export function saveRecords(dataDir, pluginId, records) {
  writeJsonAtomic(recordsPath(dataDir, pluginId), records);
}

/** 欠账：每次点跳过累计 10 秒，封顶 DEBT_MAX */
export function addDebt(records, skips = 1) {
  const count = Math.max(0, Number(skips) || 0);
  records.debtSeconds = Math.min(DEBT_MAX, records.debtSeconds + count * DEBT_PER_SKIP);
  return records.debtSeconds;
}

/** 阶段成就：按累计值返回达到的最高等级 index（未达任何级返回 -1） */
export function tieredLevelFor(achievement, records) {
  const value = achievement.progress(records);
  let level = -1;
  for (let i = 0; i < achievement.levels.length; i += 1) {
    if (value >= achievement.levels[i].threshold) level = i;
  }
  return level;
}

/** 检查并解锁新成就（含阶段升级），返回本次新增的 [{ id, name, level, praise, tierName }] */
function checkAchievements(records, fullEvent) {
  const newAchievements = [];
  for (const achievement of ACHIEVEMENTS) {
    if (achievement.tier === "once") {
      if (records.unlocked[achievement.id] !== undefined) continue;
      if (achievement.test(fullEvent, records)) {
        records.unlocked[achievement.id] = 0;
        records.newUnlocked.push({ id: achievement.id, level: 0 });
        newAchievements.push({
          id: achievement.id,
          name: achievement.name,
          level: 0,
          tierName: "",
          praise: achievement.praise,
        });
      }
    } else {
      const level = tieredLevelFor(achievement, records);
      const current = records.unlocked[achievement.id] ?? -1;
      if (level > current) {
        records.unlocked[achievement.id] = level;
        records.newUnlocked.push({ id: achievement.id, level });
        newAchievements.push({
          id: achievement.id,
          name: achievement.name,
          level,
          tierName: TIER_NAMES[level],
          praise: achievement.levels[level].praise,
        });
      }
    }
  }
  return newAchievements;
}

/** 结算一次窗口（completed：统计、成就、还清欠账） */
export function settleRest(dataDir, pluginId, records, event, now = new Date()) {
  records.completedCount += 1;
  const skips = Math.max(0, Number(event.skips) || 0);
  records.totalSkips += skips;
  records.totalExtraSec += (Number(event.extraSeconds) || 0) + (Number(event.paidSeconds) || 0);

  // 斗智斗勇时长按点击次数近似：每次 10 秒；其余时间都算休息
  const durationSec = Math.max(0, Number(event.durationSec) || 0);
  const struggleSec = Math.min(skips * STRUGGLE_PER_SKIP, durationSec);
  records.totalStruggleSec += struggleSec;
  records.totalRestSec += durationSec - struggleSec;

  // 连续天数
  const today = toDateKey(now);
  if (records.lastRestDate === toDateKey(new Date(now.getTime() - 86400000))) {
    records.streakDays += 1;
  } else if (records.lastRestDate !== today) {
    records.streakDays = 1;
  }
  records.lastRestDate = today;

  // 还清欠账
  const paidSeconds = Number(event.paidSeconds) || 0;
  if (records.debtSeconds > 0) records.debtSeconds = 0;

  // 成就检查
  const fullEvent = {
    completed: true,
    hour: now.getHours(),
    paidSeconds,
    ...event,
  };
  const newAchievements = checkAchievements(records, fullEvent);

  saveRecords(dataDir, pluginId, records);

  const praise = newAchievements.length
    ? newAchievements[0].praise
    : randomPraise();
  return { records, newAchievements, praise };
}

/** 结算一次逃逸（escaped：欠账继续累计，只记跳过与斗智斗勇） */
export function settleEscape(dataDir, pluginId, records, event) {
  const skips = Math.max(0, Number(event.skips) || 0);
  records.totalSkips += skips;
  addDebt(records, skips);
  // 逃逸窗口：按点击次数近似搏斗时间，其余不计（逃了不算休息）
  const durationSec = Math.max(0, Number(event.durationSec) || 0);
  records.totalStruggleSec += Math.min(skips * STRUGGLE_PER_SKIP, durationSec);
  saveRecords(dataDir, pluginId, records);
  return records;
}

/** 成就已查看：清空未读标记并持久化 */
export function markAchievementsViewed(dataDir, pluginId, records) {
  records.newUnlocked = [];
  saveRecords(dataDir, pluginId, records);
  return records;
}

/** 称号：按已解锁成就数量返回当前称号 */
export function titleFor(records) {
  const count = Object.keys(records.unlocked || {}).length;
  let title = TITLES[0];
  for (const candidate of TITLES) {
    if (count >= candidate.count) title = candidate;
  }
  return { ...title, count };
}

const praisePickers = new Map();
function randomPraise() {
  if (!praisePickers.has("global")) praisePickers.set("global", createRoundRobin(PRAISE_REPLIES));
  return praisePickers.get("global")();
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
