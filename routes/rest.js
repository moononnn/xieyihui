// 歇一会 - 设置页面与 API

import { state } from "../tools/_lib/state.js";
import { restartTick, start as startTimer } from "../tools/_lib/timer.js";
import { writeJsonAtomic } from "../tools/_lib/fsutil.js";
import path from "node:path";
import { ACHIEVEMENTS, loadRecords, markAchievementsViewed, TIER_NAMES, titleFor } from "../tools/_lib/records.js";
import {
  extractModelText,
  getAvailableTextModels,
  mergeModelConfig,
  readModelConfig,
  sampleConfiguredModel,
  sanitizeModelConfig,
  validateModelConfig,
  writeModelConfig,
} from "../tools/_lib/model-config.js";

// 两个选项组的预设值与自定义输入约束
// unit = 存储单位（也是显示格式化单位）；inputUnit = 输入框外挂的单位提示
const OPTIONS = {
  workInterval: { presets: [10, 20, 30], unit: "分钟", inputUnit: "分钟", placeholder: "如 50", maxLabel: "480 分钟以内就好啦" },
  breakDuration: { presets: [20, 30, 60], unit: "秒", inputUnit: "分钟", placeholder: "如 2 或 1.5", maxLabel: "120 分钟以内就好啦" },
  awayThresholdMinutes: { presets: [3, 5, 10], unit: "分钟", inputUnit: "分钟", placeholder: "如 8", maxLabel: "120 分钟以内就好啦" },
};
const LIMITS = { workInterval: 480, breakDuration: 7200, awayThresholdMinutes: 120 };
const BUS_TIMEOUT_MS = 8000;
const MODEL_TEST_TIMEOUT_MS = 22000;

// 解析自定义输入：框外已带单位提示（分钟），框内只填数字。
// 分钟存储（工作间隔）直接取整；秒存储（休息时长）按分钟×60 换算。
// 注意：此函数会 toString 后内联进前端模板字符串，内部禁止反斜杠与 `${`。
export function parseCustomDuration(text, unit) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return null;
  const m = s.match(/^([0-9]+(?:[.][0-9]+)?)$/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  if (unit === "分钟") {
    if (v < 1) return null;
    return Math.round(v);
  }
  const seconds = v * 60;
  if (seconds < 1) return null;
  return Math.round(seconds);
}

// 选项按钮上的显示文案。同样会 toString 内联进前端，禁止反斜杠与 `${`。
export function formatOptionValue(value, unit) {
  const v = Number(value) || 0;
  if (unit === "秒") {
    if (v >= 60 && v % 60 === 0) return String(v / 60) + " 分钟";
    return String(v) + " 秒";
  }
  return String(v) + " " + unit;
}

// 成就图标库：手绘 SVG 线条图标（24×24 viewBox，跟随 currentColor）
const ICONS = {
  seedling: '<path d="M12 21v-8"/><path d="M12 13c-1-3-4-5-7-5 0 4 2 7 7 5z"/><path d="M12 13c1-3 4-5 7-5 0 4-2 7-7 5z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/>',
  return: '<path d="M20 11a8 8 0 1 0 1 5"/><path d="M20 4v7h-7"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2V5z"/><path d="M18 19H6a2 2 0 0 1 0-4h12"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  trophy: '<path d="M8 3h8v6a4 4 0 0 1-8 0V3z"/><path d="M8 5H5v1a4 4 0 0 0 3 4"/><path d="M16 5h3v1a4 4 0 0 1-3 4"/><path d="M12 13v4"/><path d="M9 20h6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  cup: '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/><path d="M8 3c-1 1-1 2 0 3 1 1 1 2 0 3"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4M16 3v4"/>',
  hourglass: '<path d="M7 3h10v3l-5 5-5-5V3z"/><path d="M7 21h10v-3l-5-5-5 5v3z"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  // 阶段成就分级变体：细节随等级丰富（-0 黄铜 → -3 白金）
  "cup-0": '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/><path d="M8 3c-1 1-1 2 0 3"/>',
  "cup-1": '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/><path d="M8 3c-1 1-1 2 0 3"/><path d="M11 3c-1 1-1 2 0 3"/>',
  "cup-2": '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/><path d="M8 3c-1 1-1 2 0 3"/><path d="M11 3c-1 1-1 2 0 3"/><path d="M6 12h8"/>',
  "cup-3": '<path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/><path d="M16 9h2a2 2 0 0 1 0 4h-2"/><path d="M8 3c-1 1-1 2 0 3"/><path d="M11 3c-1 1-1 2 0 3"/><path d="M14 3c-1 1-1 2 0 3"/><path d="M6 11.5h8"/>',
  "flag-0": '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/>',
  "flag-1": '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/><circle cx="10" cy="6" r="1.1" fill="currentColor" stroke="none"/>',
  "flag-2": '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/><path d="M10 5.2l1.2 1.2-1.2 1.2-1.2-1.2z" fill="currentColor" stroke="none"/><path d="M5 21h4"/>',
  "flag-3": '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/><path d="M10 5.2l1.2 1.2-1.2 1.2-1.2-1.2z" fill="currentColor" stroke="none"/><path d="M5 21h4"/><circle cx="5" cy="3.4" r="0.9" fill="currentColor" stroke="none"/><path d="M7.5 11.2h7"/>',
  "calendar-0": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4M16 3v4"/>',
  "calendar-1": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4M16 3v4"/><circle cx="9" cy="13" r="1.1" fill="currentColor" stroke="none"/>',
  "calendar-2": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4M16 3v4"/><circle cx="9" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.1" fill="currentColor" stroke="none"/>',
  "calendar-3": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4M16 3v4"/><circle cx="9" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/>',
  "hourglass-0": '<path d="M7 3h10v3l-5 5-5-5V3z"/><path d="M7 21h10v-3l-5-5-5 5v3z"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  "hourglass-1": '<path d="M7 3h10v3l-5 5-5-5V3z"/><path d="M7 21h10v-3l-5-5-5 5v3z"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M12 6.5v3.5"/>',
  "hourglass-2": '<path d="M5 3h14"/><path d="M7 3h10v3l-5 5-5-5V3z"/><path d="M7 21h10v-3l-5-5-5 5v3z"/><path d="M5 21h14"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M12 6.5v3.5"/>',
  "hourglass-3": '<path d="M5 3h14"/><path d="M7 3h10v3l-5 5-5-5V3z"/><path d="M7 21h10v-3l-5-5-5 5v3z"/><path d="M5 21h14"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M12 6.5v3.5"/><circle cx="11" cy="17" r="0.8" fill="currentColor" stroke="none"/><circle cx="13" cy="17" r="0.8" fill="currentColor" stroke="none"/>',
};

const ICON_SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

export default function (app, ctx) {
  startTimer(ctx);

  app.get("/page", (c) => c.html(renderSettings(ctx)));

  app.post("/api/update-config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const allowed = ["workInterval", "breakDuration", "enableBreaks", "forceMode", "pauseOnFullscreen", "pauseOnAway", "awayThresholdMinutes"];
    const changed = [];

    for (const key of allowed) {
      if (body[key] === undefined) continue;
      if (key === "enableBreaks" || key === "forceMode" || key === "pauseOnFullscreen" || key === "pauseOnAway") {
        state.config[key] = Boolean(body[key]);
      } else {
        const value = Number(body[key]);
        if (!Number.isFinite(value) || value < 1) {
          return c.json({ ok: false, error: "数值必须大于 0" }, 400);
        }
        const max = LIMITS[key];
        if (max && value > max) {
          const label = key === "workInterval" ? "工作间隔" : "休息时长";
          const unit = key === "workInterval" ? " 分钟" : " 秒";
          return c.json({ ok: false, error: label + "不能超过 " + max + unit }, 400);
        }
        state.config[key] = Math.round(value);
      }
      changed.push(key);
    }

    if (changed.length) {
      saveConfig(ctx);
      restartTick();
      ctx.log?.info?.("休息配置已更新", { changed });
    }
    return c.json({ ok: true, changed, config: state.config });
  });

  app.get("/api/status", (c) => c.json({
    ok: true,
    phase: state.phase,
    pauseReason: state.pauseReason,
    config: { ...state.config },
    skippedCount: state.skippedCount,
  }));

  app.get("/api/model-config", async (c) => {
    const config = readModelConfig(ctx.dataDir, ctx.pluginId);
    let agentName = "当前助手";
    let hostModel = "";
    try {
      const agentResult = await withTimeout(ctx.bus.request("agent:list", {}), BUS_TIMEOUT_MS, "读取助手超时");
      const agents = Array.isArray(agentResult?.agents) ? agentResult.agents : [];
      const agent = agents.find((item) => item?.isCurrent)
        || agents.find((item) => item?.isPrimary)
        || agents[0];
      if (agent) {
        agentName = agent.name || agent.id || agentName;
        try {
          const profileResult = await withTimeout(
            ctx.bus.request("agent:profile", { agentId: agent.id }),
            BUS_TIMEOUT_MS,
            "读取助手模型超时",
          );
          hostModel = describeModelRef(profileResult?.profile?.models?.utility);
        } catch {}
      }
    } catch {}

    return c.json({
      ok: true,
      data: {
        config: sanitizeModelConfig(config),
        models: getAvailableTextModels(),
        agentName,
        hostModel,
      },
    });
  });

  app.post("/api/model-config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const current = readModelConfig(ctx.dataDir, ctx.pluginId);
    const next = mergeModelConfig(current, body);
    const error = validateModelConfig(next);
    if (error) return c.json({ ok: false, error }, 400);
    // 保存用校验过的 next（而不是原始 body），保证“校验什么、落盘什么”一致
    const saved = writeModelConfig(ctx.dataDir, ctx.pluginId, next);
    return c.json({ ok: true, data: { config: sanitizeModelConfig(saved) }, message: "模型配置已保存" });
  });

  app.post("/api/model-test", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const current = readModelConfig(ctx.dataDir, ctx.pluginId);
    const config = mergeModelConfig(current, body);
    const error = validateModelConfig(config);
    if (error) return c.json({ ok: false, error }, 400);

    try {
      const result = await withTimeout(sampleConfiguredModel(ctx, config, {
        messages: [{ role: "user", content: "你好，这是一条连接测试消息。请用一句话简短回应。" }],
        maxTokens: 100,
        temperature: 0.5,
        operation: "xieyihui-model-test",
      }, MODEL_TEST_TIMEOUT_MS), MODEL_TEST_TIMEOUT_MS, "模型连接超时");
      const text = extractModelText(result).trim();
      return c.json({
        ok: true,
        data: {
          reply: text.slice(0, 200) || "连接成功（模型没有返回文字）",
          source: config.source,
          model: config.source === "custom" ? config.customModel : config.modelId,
        },
      });
    } catch (error) {
      return c.json({ ok: false, error: error.message || "模型连接失败" });
    }
  });

  app.get("/api/achievements", (c) => {
    const records = loadRecords(ctx.dataDir, ctx.pluginId);
    const unlocked = records.unlocked || {};
    const newUnlocked = Array.isArray(records.newUnlocked) ? records.newUnlocked : [];
    const newSet = new Set(newUnlocked.map((item) => `${item?.id}|${item?.level ?? 0}`));
    const achievements = ACHIEVEMENTS.map((a) => {
      const level = unlocked[a.id] ?? -1;
      if (a.tier === "once") {
        return {
          id: a.id, name: a.name, desc: a.desc, icon: a.icon, tier: a.tier,
          level, unlocked: level >= 0, isNew: newSet.has(`${a.id}|0`),
        };
      }
      return {
        id: a.id, name: a.name, desc: a.desc, tier: a.tier,
        icon: a.icons[Math.max(0, level)],
        level, unlocked: level >= 0,
        progress: a.progress(records),
        unit: a.unit,
        levels: a.levels.map((l, i) => ({ threshold: l.threshold, title: l.title, tierName: TIER_NAMES[i] })),
        isNew: newSet.has(`${a.id}|${level}`),
      };
    });
    return c.json({
      ok: true,
      data: {
        records: {
          totalRestSec: records.totalRestSec,
          totalExtraSec: records.totalExtraSec,
          totalStruggleSec: records.totalStruggleSec,
          totalSkips: records.totalSkips,
          completedCount: records.completedCount,
          debtSeconds: records.debtSeconds,
          streakDays: records.streakDays,
        },
        newCount: newUnlocked.length,
        title: titleFor(records),
        achievements,
      },
    });
  });

  app.post("/api/achievements-viewed", (c) => {
    const records = loadRecords(ctx.dataDir, ctx.pluginId);
    markAchievementsViewed(ctx.dataDir, ctx.pluginId, records);
    return c.json({ ok: true });
  });

}

function withTimeout(promise, timeoutMs, message = "读取模型配置超时") {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function describeModelRef(ref) {
  if (typeof ref === "string") return ref.trim();
  if (!ref || typeof ref !== "object") return "";
  return [ref.provider || ref.providerId, ref.id || ref.modelId || ref.model]
    .filter(Boolean)
    .join(" / ");
}

function saveConfig(ctx) {
  writeJsonAtomic(path.join(ctx.dataDir, ctx.pluginId, "config.json"), state.config);
}

function renderSettings(ctx) {
  const pluginId = ctx.pluginId;
  const cfg = state.config;
  const phaseLabel = state.phase === "working" ? "工作中" : state.phase === "breaking" ? "休息中" : "已暂停";
  const pauseLabels = {
    fullscreen: "全屏中，计时暂停",
    dnd: "免打扰模式，计时暂停",
    away: "暂离中，计时暂停",
  };
  const pauseSuffix = state.pauseReason ? ` · ${pauseLabels[state.pauseReason] || "计时暂停中"}` : "";
  // 服务端渲染模型配置摘要，避免页面打开时显示写死的默认文案
  let modelSummaryText = "跟随当前助手";
  try {
    const modelConfig = readModelConfig(ctx.dataDir, ctx.pluginId);
    if (modelConfig.source === "hana") {
      let found = "";
      for (const provider of getAvailableTextModels()) {
        if (provider.providerId !== modelConfig.providerId) continue;
        const model = provider.models.find((item) => item.id === modelConfig.modelId);
        found = provider.providerName + " / " + (model ? model.name : modelConfig.modelId);
        break;
      }
      modelSummaryText = found ? "Hana · " + found : "Hana · " + modelConfig.providerId + " / " + modelConfig.modelId;
    } else if (modelConfig.source === "custom") {
      modelSummaryText = "自定义 API · " + (modelConfig.customModel || "未填写模型");
    }
  } catch {}
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>歇一会</title>
<style>
:root {
  --mint: #5f9f85;
  --mint-deep: #366b59;
  --mint-soft: #e8f3ed;
  --paper: #fbf8f1;
  --paper-card: #fffdf8;
  --pink: #d98291;
  --pink-soft: #f9e8ea;
  --line: #c8d9cf;
  --text: #405c52;
  --muted: #80978e;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  min-height: 100vh;
  padding: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  background: var(--paper);
  font-family: "LXGW WenKai", "霞鹜文楷", "Noto Sans SC", system-ui, sans-serif;
}
.sheet {
  width: min(920px, 100%);
  padding: 28px;
  border: 1px dashed var(--line);
  border-radius: 22px;
  background: var(--paper-card);
  box-shadow: 0 12px 32px rgba(67, 100, 87, .08);
}
.header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
h1 { margin: 0 0 6px; color: var(--mint-deep); font-size: 28px; font-weight: 700; letter-spacing: 1px; }
.subtitle { margin: 0; color: var(--muted); font-size: 14px; }
.badge { flex: 0 0 auto; padding: 6px 12px; border-radius: 999px; background: var(--mint-soft); color: var(--mint-deep); font-size: 13px; }
.badge.force { background: var(--pink-soft); color: #a85160; }
.status {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 20px; padding: 12px 14px;
  border-radius: 14px; background: var(--mint-soft); font-size: 14px;
}
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 4px rgba(95,159,133,.13); }
.group { margin: 18px 0; }
.group-title { margin-bottom: 10px; font-size: 14px; color: var(--mint-deep); }
.section-title {
  display: inline-flex; align-items: center;
  margin: 22px 0 12px; padding: 4px 14px;
  border: 1px solid var(--mint); border-radius: 999px;
  background: var(--mint-soft); color: var(--mint-deep);
  font-size: 13px; font-weight: 700; letter-spacing: 1px;
}
.toggle-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.toggle-card {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 16px 18px; border: 1px dashed var(--line); border-radius: 16px;
  background: #fffefa; transition: transform .16s ease, border-color .16s ease;
}
.toggle-card:hover { transform: translateY(-1px); border-color: var(--mint); }
.toggle-card .desc { margin-top: 4px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.toggle-card.tall { flex-direction: column; align-items: stretch; }
.tcard-top { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.tcard-sub { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--line); }
.tcard-sub-title { margin-bottom: 8px; color: var(--muted); font-size: 12px; }
.tcard-sub .options { grid-template-columns: repeat(4, 1fr); gap: 6px; }
.tcard-sub .option { min-height: 34px; border-radius: 10px; font-size: 12px; }
.force-note {
  display: inline-flex; align-items: center;
  margin-top: 6px; padding: 2px 10px;
  border-radius: 999px; background: var(--pink-soft);
  color: #a85160; font-size: 12px;
}
.ach-status { margin-left: auto; background: var(--paper-card); }
.status .ach-badge { box-shadow: 0 0 0 2px var(--mint-soft); }
.options { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.option, .toggle {
  border: 1px solid var(--line); background: #fffefa; color: var(--text);
  font: inherit; cursor: pointer; transition: transform .16s ease, background .16s ease, border-color .16s ease;
}
.option { min-height: 42px; border-radius: 12px; font-size: 13px; }
.option:hover, .toggle:hover { transform: translateY(-1px); border-color: var(--mint); }
.option.selected { background: var(--mint); border-color: var(--mint); color: white; }
.custom-edit {
  display: flex; align-items: center; justify-content: center; gap: 2px;
  padding: 0 10px; cursor: text; background: #fff;
}
.custom-edit:focus-within {
  outline: 2px solid var(--mint); outline-offset: -2px; border-color: var(--mint);
}
.custom-input {
  flex: 1; min-width: 0; padding: 0; border: 0; outline: none;
  background: transparent; color: var(--text); font-size: 13px; text-align: right;
}
.custom-unit {
  flex: 0 0 auto; color: var(--mint-deep); font-size: 12px; white-space: nowrap;
}
.setting-row {
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding: 16px 0; border-top: 1px dashed var(--line);
}
.label { font-size: 15px; color: var(--mint-deep); }
.desc { margin-top: 4px; font-size: 12px; color: var(--muted); }
.segment { display: grid; grid-template-columns: repeat(2, 54px); padding: 3px; border-radius: 12px; background: var(--mint-soft); }
.toggle { min-height: 34px; border: 0; border-radius: 9px; background: transparent; font-size: 13px; }
.toggle.active { background: white; color: var(--mint-deep); box-shadow: 0 2px 8px rgba(67,100,87,.09); }
.segment.danger { background: var(--pink-soft); }
.segment.danger .toggle.active { color: #a85160; }
.entry-button, .auto-tag {
  flex: 0 0 auto; min-height: 34px; padding: 0 12px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--mint-soft); color: var(--mint-deep);
  font: inherit; font-size: 13px;
}
.entry-button { cursor: pointer; }
.entry-button:hover { border-color: var(--mint); transform: translateY(-1px); }
.auto-tag { display: inline-flex; align-items: center; border-style: dashed; }
.note { margin: 10px 2px 0; text-align: left; color: var(--muted); font-size: 12px; line-height: 1.6; }
.modal-backdrop {
  position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
  padding: 18px; background: rgba(64, 92, 82, .18); z-index: 10;
}
.modal-backdrop.show { display: flex; }
.modal-card {
  width: min(520px, 100%); max-height: min(720px, calc(100vh - 32px));
  display: flex; flex-direction: column; border: 1px dashed var(--line);
  border-radius: 18px; background: var(--paper-card); box-shadow: 0 16px 36px rgba(67, 100, 87, .16);
}
.modal-head {
  flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
  padding: 20px 22px 14px; color: var(--mint-deep); font-size: 18px; font-weight: 700;
  border-bottom: 1px dashed var(--line);
}
.modal-close {
  border: 0; background: transparent; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer;
}
.modal-body { min-height: 0; overflow-y: auto; padding: 18px 22px; }
.modal-foot {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 14px 22px 18px; border-top: 1px dashed var(--line); background: var(--paper-card);
}
.model-field { display: block; margin-bottom: 14px; color: var(--mint-deep); font-size: 13px; }
.model-field > span { display: block; margin-bottom: 6px; }
.model-field select, .model-field input {
  width: 100%; min-height: 38px; padding: 8px 10px; border: 1px solid var(--line);
  border-radius: 10px; background: #fffefa; color: var(--text); font: inherit; font-size: 13px;
}
.model-field select:focus, .model-field input:focus { outline: 2px solid rgba(95, 159, 133, .20); border-color: var(--mint); }
.model-select-grid { display: grid; grid-template-columns: 1fr 1.35fr; gap: 10px; }
.model-hint { margin: -4px 0 14px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.model-test-button, .model-save-button {
  min-height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--mint-soft); color: var(--mint-deep); font: inherit; font-size: 13px; cursor: pointer;
}
.model-save-button { margin-left: auto; border-color: var(--mint); background: var(--mint); color: white; }
.model-test-button:hover, .model-save-button:hover { transform: translateY(-1px); }
.model-test-button:disabled, .model-save-button:disabled { cursor: wait; opacity: .58; transform: none; }
.model-test-result { flex: 1 1 160px; min-width: 120px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.modal-note { margin: 4px 0 8px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.stats-card {
  padding: 14px; border: 1px dashed var(--line); border-radius: 14px;
  background: #fffefa; font-size: 13px;
}
.stats-loading { color: var(--muted); font-size: 12px; }
.stats-title { color: var(--mint-deep); font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
.stat-item {
  padding: 10px 8px; border-radius: 12px; background: var(--mint-soft);
  text-align: center; min-width: 0;
}
.stat-num { color: var(--mint-deep); font-size: 14px; font-weight: 700; white-space: nowrap; }
.stat-label { margin-top: 4px; color: var(--muted); font-size: 11px; }
.ach-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.ach-card {
  position: relative; padding: 12px; border: 1px dashed var(--line); border-radius: 14px;
  background: #fffefa; display: flex; gap: 10px; align-items: flex-start;
}
.ach-card.locked { opacity: .62; }
.ach-card.new { border-color: var(--pink); background: #fdf6f3; animation: ach-pop .5s ease; }
.ach-icon {
  flex: 0 0 auto; width: 38px; height: 38px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  background: var(--mint-soft); color: var(--mint-deep);
}
.ach-icon svg { width: 22px; height: 22px; }
.ach-card.locked .ach-icon { background: #f1ede4; color: #b9b2a2; }
.ach-info { min-width: 0; flex: 1; }
.ach-name {
  font-size: 13px; font-weight: 700; color: var(--mint-deep);
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.ach-card.locked .ach-name { color: var(--muted); }
.ach-desc { margin-top: 3px; font-size: 11px; color: var(--muted); line-height: 1.5; }
.ach-title-tag {
  display: inline-flex; align-items: center; margin-top: 4px;
  padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--muted);
  font-size: 10px; background: #f8f5ec;
}
.ach-card.tier-0 .ach-title-tag { border-color: #b87333; color: #a0642a; background: #f6e9dd; }
.ach-card.tier-1 .ach-title-tag { border-color: #9aa2ad; color: #7d8794; background: #eceff2; }
.ach-card.tier-2 .ach-title-tag { border-color: #c9a227; color: #a8861e; background: #faf3dd; }
.ach-card.tier-3 .ach-title-tag { border-color: #c3cad6; color: #8a94a5; background: #eef1f6; }
.ach-new-tag {
  flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; background: var(--pink); color: white;
  font-size: 10px; line-height: 1.6;
}
.tier-bar { height: 4px; border-radius: 2px; background: #efe9dc; margin-top: 8px; overflow: hidden; }
.tier-bar-fill { height: 100%; border-radius: 2px; transition: width .3s ease; }
.tier-progress { margin-top: 4px; font-size: 10px; color: var(--muted); }
/* 阶段成就卡片：按当前级别上金属色边框、图标底色与进度条颜色 */
.ach-card.tier-0 { border-color: #b87333; border-style: solid; }
.ach-card.tier-0 .ach-icon { background: #f6e9dd; color: #a0642a; }
.ach-card.tier-0 .tier-bar-fill { background: #b87333; }
.ach-card.tier-1 { border-color: #9aa2ad; border-style: solid; }
.ach-card.tier-1 .ach-icon { background: #eceff2; color: #7d8794; }
.ach-card.tier-1 .tier-bar-fill { background: #9aa2ad; }
.ach-card.tier-2 { border-color: #c9a227; border-style: solid; }
.ach-card.tier-2 .ach-icon { background: #faf3dd; color: #a8861e; }
.ach-card.tier-2 .tier-bar-fill { background: #c9a227; }
.ach-card.tier-3 { border-color: #c3cad6; border-style: solid; }
.ach-card.tier-3 .ach-icon { background: #eef1f6; color: #8a94a5; }
.ach-card.tier-3 .tier-bar-fill { background: #c3cad6; }
.ach-card.locked .tier-bar-fill { background: #c9c2b2; }
.ach-summary { padding: 14px; border: 1px dashed var(--line); border-radius: 14px; background: #fffefa; font-size: 13px; margin-bottom: 12px; }
.ach-summary-title { color: var(--mint-deep); font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.ach-entry { position: relative; display: inline-flex; align-items: center; gap: 6px; }
.ach-entry-icon { width: 15px; height: 15px; }
.ach-badge {
  position: absolute; top: -7px; right: -7px; min-width: 16px; height: 16px;
  border-radius: 999px; background: var(--pink); color: white;
  font-size: 10px; line-height: 16px; text-align: center; padding: 0 4px;
  box-shadow: 0 0 0 2px var(--paper-card);
}
@keyframes ach-pop { 0% { transform: scale(.96); } 60% { transform: scale(1.02); } 100% { transform: scale(1); } }
@media (max-width: 520px) {
  .stats-grid { grid-template-columns: 1fr; }
  .ach-grid { grid-template-columns: 1fr; }
}
.toast {
  position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 12px);
  padding: 10px 16px; border-radius: 12px; background: var(--mint-deep); color: white;
  font-size: 13px; opacity: 0; pointer-events: none; transition: .2s ease;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
@media (max-width: 760px) {
  .toggle-grid { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  body { padding: 14px; }
  .sheet { padding: 20px; }
  .options { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body>
<main class="sheet">
  <div class="header">
    <div>
      <h1>歇一会</h1>
      <p class="subtitle">到时间，就先把身体还给自己一会儿。</p>
    </div>
    <span class="badge ${cfg.forceMode ? "force" : ""}" id="modeBadge">${cfg.forceMode ? "强制模式" : "普通模式"}</span>
  </div>

  <div class="status"><span class="dot"></span><span class="status-text">${phaseLabel}${pauseSuffix}${state.skippedCount ? ` · 已跳过 ${state.skippedCount} 次` : ""}</span>
    <button class="entry-button ach-entry ach-status" id="achButton" type="button">
      <svg class="ach-entry-icon" ${ICON_SVG_ATTRS} aria-hidden="true">${ICONS.trophy}</svg>
      <span>成就</span>
      <span class="ach-badge" id="achBadge" hidden>0</span>
    </button>
  </div>

  <h2 class="section-title">计时节奏</h2>
  ${renderOptions("workInterval", "工作间隔", OPTIONS.workInterval.presets, cfg.workInterval, "分钟")}
  ${renderOptions("breakDuration", "休息时长", OPTIONS.breakDuration.presets, cfg.breakDuration, "秒")}

  <h2 class="section-title">提醒的方式</h2>
  <div class="toggle-grid">
    <div class="toggle-card">
      <div><div class="label">休息提醒</div><div class="desc">关闭后停止计时，也不会弹出全屏提醒。</div></div>
      ${renderToggle("enableBreaks", cfg.enableBreaks, false)}
    </div>
    <div class="toggle-card">
      <div><div class="label">强制模式</div><div class="desc">跳过按钮会变成劝阻按钮，回应会提前准备，点击后立即反馈。</div><div class="force-note">谨慎开启！小花（或其他助手）会想尽办法让你休息的！</div></div>
      ${renderToggle("forceMode", cfg.forceMode, true)}
    </div>
  </div>

  <h2 class="section-title">忙的时候先等等</h2>
  <div class="toggle-grid">
    <div class="toggle-card">
      <div><div class="label">全屏时暂停</div><div class="desc">看视频、玩游戏全屏时先不打扰，计时暂停，退出全屏再继续。</div></div>
      ${renderToggle("pauseOnFullscreen", cfg.pauseOnFullscreen, false)}
    </div>
    <div class="toggle-card tall">
      <div class="tcard-top">
        <div><div class="label">暂离暂停</div><div class="desc">超过一段时间没动鼠标键盘，就当你走开了，计时也跟着暂停。</div></div>
        ${renderToggle("pauseOnAway", cfg.pauseOnAway, false)}
      </div>
      <div class="tcard-sub">
        <div class="tcard-sub-title">判定多久算走开</div>
        <div class="options">
          ${OPTIONS.awayThresholdMinutes.presets.map((value) => `<button class="option${value === cfg.awayThresholdMinutes ? " selected" : ""}" data-key="awayThresholdMinutes" data-value="${value}" type="button">${formatOptionValue(value, "分钟")}</button>`).join("")}
          <button class="option${!OPTIONS.awayThresholdMinutes.presets.includes(cfg.awayThresholdMinutes) ? " selected" : ""}" data-key="awayThresholdMinutes" data-custom="1" type="button">${!OPTIONS.awayThresholdMinutes.presets.includes(cfg.awayThresholdMinutes) ? formatOptionValue(cfg.awayThresholdMinutes, "分钟") : "自定义"}</button>
        </div>
      </div>
    </div>
  </div>

  <h2 class="section-title">文案模型</h2>
  <div class="setting-row">
    <div><div class="label">文案模型</div><div class="desc" id="modelDescription">${modelSummaryText}</div></div>
    <button class="entry-button" id="modelButton" type="button">配置</button>
  </div>
  <p class="note">配好文案模型后，劝你休息的话会更贴你的说话风格，还会带上最近的聊天。模型暂时不可用时，自动换通用的暖心话，不碰你的隐私。</p>
</main>
<div class="modal-backdrop" id="modelModal" role="dialog" aria-modal="true" aria-labelledby="modelTitle">
  <section class="modal-card">
    <div class="modal-head"><span id="modelTitle">模型配置</span><button class="modal-close" id="modelClose" type="button" aria-label="关闭">×</button></div>
    <div class="modal-body">
      <label class="model-field"><span>使用方式</span>
        <select id="modelSource">
          <option value="agent">跟随当前助手</option>
          <option value="hana">从 Hana 已配置模型中选择</option>
          <option value="custom">自定义 API</option>
        </select>
      </label>

      <div id="modelHanaBlock">
        <div class="model-select-grid">
          <label class="model-field"><span>供应商</span><select id="modelProvider"><option value="">正在读取…</option></select></label>
          <label class="model-field"><span>模型</span><select id="modelModel"><option value="">请先选择供应商</option></select></label>
        </div>
        <p class="model-hint" id="modelCatalogHint">列表来自 Hana 当前可用的文本模型，不会把供应商密钥交给插件页面。</p>
      </div>

      <div id="modelCustomBlock" hidden>
        <label class="model-field"><span>Base URL</span><input id="modelCustomUrl" type="text" placeholder="https://api.example.com/v1"></label>
        <label class="model-field"><span>API Key</span><input id="modelCustomKey" type="password" placeholder="留空则保留已保存的 Key"></label>
        <label class="model-field"><span>模型名</span><input id="modelCustomModel" type="text" placeholder="deepseek-chat"></label>
        <p class="model-hint">自定义配置只保存在歇一会自己的数据目录里，页面只显示脱敏占位符。</p>
      </div>

      <p class="modal-note">测试只发送一条很短的连接测试消息，不会保存表单；保存后，休息前预生成和点击后的劝阻文案都会使用这里的选择。</p>
    </div>
    <div class="modal-foot">
      <button class="model-test-button" id="modelTest" type="button">测试连通</button>
      <span class="model-test-result" id="modelTestResult"></span>
      <button class="model-save-button" id="modelSave" type="button">保存配置</button>
    </div>
  </section>
</div>
<div class="modal-backdrop" id="achModal" role="dialog" aria-modal="true" aria-labelledby="achTitle">
  <section class="modal-card">
    <div class="modal-head"><span id="achTitle">成就与统计</span><button class="modal-close" id="achClose" type="button" aria-label="关闭">×</button></div>
    <div class="modal-body">
      <div class="ach-summary" id="achSummary"><div class="stats-loading">正在读取…</div></div>
      <div class="ach-grid" id="achGrid"></div>
    </div>
  </section>
</div>
<div class="toast" id="toast"></div>
<script>
var ICONS = ${JSON.stringify(ICONS)};
var OPTIONS = ${JSON.stringify(OPTIONS)};
var LIMITS = ${JSON.stringify(LIMITS)};
var CURRENT_CONFIG = ${JSON.stringify(cfg)};
var parseCustomDuration = ${parseCustomDuration.toString()};
var formatOptionValue = ${formatOptionValue.toString()};
(function () {
  var pluginId = ${JSON.stringify(pluginId)};
  var params = new URLSearchParams(window.location.search || '');
  var surfaceSession = params.get('pluginSurfaceSession');
  var legacyToken = params.get('token');

  function api(path, init) {
    var cleanPath = path.charAt(0) === '/' ? path.slice(1) : path;
    if (window.hana && window.hana.api && typeof window.hana.api.fetch === 'function') {
      return window.hana.api.fetch(cleanPath, init || {});
    }
    var request = Object.assign({}, init || {});
    var headers = Object.assign({}, request.headers || {});
    var url = '/api/plugins/' + encodeURIComponent(pluginId) + '/' + cleanPath;
    if (surfaceSession) {
      headers['X-Hana-Plugin-Surface-Session'] = surfaceSession;
    } else if (legacyToken) {
      url += '?token=' + encodeURIComponent(legacyToken);
    } else {
      return Promise.reject(new Error('缺少插件页面凭证'));
    }
    request.headers = headers;
    return fetch(url, request);
  }

  function showToast(text) {
    var toast = document.getElementById('toast');
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.classList.remove('show'); }, 1800);
  }

  function save(patch, after, onFail) {
    return api('api/update-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(function (response) {
      if (!response.ok) throw new Error('保存失败');
      return response.json();
    }).then(function (data) {
      if (!data.ok) throw new Error(data.error || '保存失败');
      if (after) after();
      showToast('已保存');
    }).catch(function () {
      showToast('没保存上，请再试一次');
      if (onFail) onFail();
    });
  }

  function toInputValue(storeValue, unit) {
    if (unit === '分钟') return String(storeValue);
    var v = storeValue / 60;
    return String(Math.round(v * 100) / 100);
  }

  function syncOptionState(key) {
    var opt = OPTIONS[key];
    if (!opt) return;
    var value = CURRENT_CONFIG[key];
    var inPreset = opt.presets.indexOf(value) >= 0;
    document.querySelectorAll('[data-key="' + key + '"][data-value]').forEach(function (item) {
      item.classList.toggle('selected', Number(item.getAttribute('data-value')) === value);
    });
    var customBtn = document.querySelector('[data-key="' + key + '"][data-custom]');
    if (customBtn) {
      customBtn.textContent = inPreset ? '自定义' : formatOptionValue(value, opt.unit);
      customBtn.classList.toggle('selected', !inPreset);
    }
  }

  document.querySelectorAll('[data-value]').forEach(function (button) {
    button.addEventListener('click', function () {
      var key = button.getAttribute('data-key');
      var value = Number(button.getAttribute('data-value'));
      save(Object.fromEntries([[key, value]]), function () {
        CURRENT_CONFIG[key] = value;
        syncOptionState(key);
      });
    });
  });

  // 自定义选项：点击后变成带单位后缀的输入框；回车或失焦保存，Esc 取消
  function bindCustomButton(button) {
    button.addEventListener('click', function () {
      if (button.querySelector('input')) return;
      var key = button.getAttribute('data-key');
      var opt = OPTIONS[key];
      var current = CURRENT_CONFIG[key];
      var inPreset = opt.presets.indexOf(current) >= 0;
      var wrap = document.createElement('div');
      wrap.className = 'option custom-edit';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'custom-input';
      input.placeholder = opt.placeholder;
      input.value = inPreset ? '' : toInputValue(current, opt.unit);
      var unitSpan = document.createElement('span');
      unitSpan.className = 'custom-unit';
      unitSpan.textContent = opt.inputUnit;
      wrap.appendChild(input);
      wrap.appendChild(unitSpan);
      var closed = false;

      function close(parsed) {
        if (closed) return;
        closed = true;
        var label = '自定义';
        var isCustom = opt.presets.indexOf(CURRENT_CONFIG[key]) < 0;
        if (parsed !== undefined) {
          label = opt.presets.indexOf(parsed) >= 0 ? '自定义' : formatOptionValue(parsed, opt.unit);
        } else if (isCustom) {
          label = formatOptionValue(CURRENT_CONFIG[key], opt.unit);
        }
        var fresh = document.createElement('button');
        fresh.type = 'button';
        fresh.className = 'option' + (parsed === undefined && isCustom ? ' selected' : '');
        fresh.setAttribute('data-key', key);
        fresh.setAttribute('data-custom', '1');
        fresh.textContent = label;
        wrap.replaceWith(fresh);
        bindCustomButton(fresh);
      }

      function submit(silent) {
        var parsed = parseCustomDuration(input.value, opt.unit);
        if (parsed === null || parsed > LIMITS[key]) {
          if (!silent) {
            showToast(parsed === null ? '填个大于 0 的数字吧' : opt.maxLabel);
          }
          close();
          return;
        }
        close(parsed);
        var patch = {};
        patch[key] = parsed;
        save(patch, function () {
          CURRENT_CONFIG[key] = parsed;
          syncOptionState(key);
        }, function () { syncOptionState(key); });
      }

      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit(false);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      });
      input.addEventListener('blur', function () { submit(true); });
      input.addEventListener('click', function (event) { event.stopPropagation(); });

      button.replaceWith(wrap);
      input.focus();
      input.select();
    });
  }
  document.querySelectorAll('[data-custom]').forEach(bindCustomButton);

  document.querySelectorAll('[data-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var key = button.getAttribute('data-toggle');
      var value = button.getAttribute('data-bool') === 'true';
      save(Object.fromEntries([[key, value]]), function () {
        document.querySelectorAll('[data-toggle="' + key + '"]').forEach(function (item) {
          item.classList.toggle('active', item === button);
        });
        if (key === 'forceMode') {
          var badge = document.getElementById('modeBadge');
          badge.textContent = value ? '强制模式' : '普通模式';
          badge.classList.toggle('force', value);
        }
      });
    });
  });

  function fmtDuration(sec) {
    sec = Number(sec) || 0;
    if (sec >= 3600) return Math.floor(sec / 3600) + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分';
    if (sec >= 60) return Math.floor(sec / 60) + ' 分钟 ' + (sec % 60) + ' 秒';
    return sec + ' 秒';
  }

  function renderAchievements(data) {
    var ach = data.achievements || [];
    var unlockedCount = 0;
    for (var i = 0; i < ach.length; i++) { if (ach[i].unlocked) unlockedCount += 1; }
    var title = data.title || { name: '', count: 0 };
    var records = data.records || {};
    var html = '<div class="ach-summary-title">『' + title.name + '』 · 已点亮 ' + unlockedCount + '/' + ach.length + ' 枚勋章</div>';
    html += '<div class="stats-grid">';
    html += '<div class="stat-item"><div class="stat-num">' + fmtDuration(records.totalRestSec) + '</div><div class="stat-label">总休息时长</div></div>';
    html += '<div class="stat-item"><div class="stat-num">' + fmtDuration(records.totalExtraSec) + '</div><div class="stat-label">加时时长</div></div>';
    html += '<div class="stat-item"><div class="stat-num">' + fmtDuration(records.totalStruggleSec) + '</div><div class="stat-label">斗智斗勇时长</div></div>';
    html += '</div>';
    document.getElementById('achSummary').innerHTML = html;

    var grid = '';
    for (var j = 0; j < ach.length; j++) {
      var a = ach[j];
      var cardCls = a.unlocked ? '' : ' locked';
      if (a.isNew) cardCls += ' new';
      if (a.tier === 'tiered' && a.unlocked) cardCls += ' tier-' + a.level;
      var newTag = a.isNew ? '<span class="ach-new-tag">新</span>' : '';
      grid += '<div class="ach-card' + cardCls + '">';
      grid += '<div class="ach-icon">' + achIconSvg(a.icon) + '</div>';
      grid += '<div class="ach-info">';
      grid += '<div class="ach-name">' + a.name + newTag + '</div>';
      if (a.tier === 'tiered' && a.unlocked) {
        var curTitle = a.levels[a.level] && a.levels[a.level].title ? a.levels[a.level].title : '';
        if (curTitle) grid += '<div class="ach-title-tag">称号 · ' + curTitle + '</div>';
      }
      grid += '<div class="ach-desc">' + a.desc + '</div>';
      if (a.tier === 'tiered') {
        var progress = Number(a.progress) || 0;
        var pct = 0;
        var progressText = '';
        if (a.unlocked && a.level < a.levels.length - 1) {
          var cur = a.levels[a.level];
          var next = a.levels[a.level + 1];
          pct = Math.max(0, Math.min(100, (progress - cur.threshold) / (next.threshold - cur.threshold) * 100));
          progressText = '还差 ' + fmtProgress(next.threshold - progress, a.unit) + ' 到下一级';
        } else if (a.unlocked) {
          pct = 100;
          progressText = '已到满级';
        } else {
          var first = a.levels[0];
          pct = Math.max(0, Math.min(100, progress / first.threshold * 100));
          progressText = '还差 ' + fmtProgress(first.threshold - progress, a.unit) + ' 到下一级';
        }
        grid += '<div class="tier-bar"><div class="tier-bar-fill" style="width:' + pct + '%"></div></div>';
        grid += '<div class="tier-progress">' + progressText + '</div>';
      }
      grid += '</div></div>';
    }
    document.getElementById('achGrid').innerHTML = grid;
  }

  function fmtProgress(value, unit) {
    var v = Math.max(0, Number(value) || 0);
    if (unit === '秒') return fmtDuration(v);
    return v + unit;
  }

  function achIconSvg(name) {
    var icons = typeof ICONS !== 'undefined' ? ICONS : {};
    var body = icons[name] || icons.trophy || '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  var achModal = document.getElementById('achModal');
  var achBadge = document.getElementById('achBadge');

  function openAchModal() {
    achModal.classList.add('show');
    document.getElementById('achSummary').innerHTML = '<div class="stats-loading">正在读取…</div>';
    document.getElementById('achGrid').innerHTML = '';
    api('api/achievements')
      .then(function (response) {
        if (!response.ok) throw new Error('读取成就失败');
        return response.json();
      })
      .then(function (data) {
        if (!data.ok || !data.data) throw new Error(data.error || '读取成就失败');
        renderAchievements(data.data);
        if (data.data.newCount > 0) {
          achBadge.hidden = true;
          api('api/achievements-viewed', { method: 'POST' }).catch(function () {});
        }
      })
      .catch(function () {
        document.getElementById('achSummary').innerHTML = '<div class="stats-loading">成就读取失败，稍后再看。</div>';
      });
  }

  document.getElementById('achButton').addEventListener('click', openAchModal);
  document.getElementById('achClose').addEventListener('click', function () { achModal.classList.remove('show'); });
  achModal.addEventListener('click', function (event) {
    if (event.target === achModal) achModal.classList.remove('show');
  });

  // 模型配置弹窗：跟随当前助手 / 从 Hana 已配置模型中选择 / 自定义 API
  var modelModal = document.getElementById('modelModal');
  var modelSource = document.getElementById('modelSource');
  var modelProvider = document.getElementById('modelProvider');
  var modelModel = document.getElementById('modelModel');
  var modelCustomUrl = document.getElementById('modelCustomUrl');
  var modelCustomKey = document.getElementById('modelCustomKey');
  var modelCustomModel = document.getElementById('modelCustomModel');
  var modelCatalogHint = document.getElementById('modelCatalogHint');
  var modelTestResult = document.getElementById('modelTestResult');
  var modelDescription = document.getElementById('modelDescription');
  var modelCatalog = [];

  function closeModelModal() { modelModal.classList.remove('show'); }

  function updateModelSourceBlocks() {
    var source = modelSource.value;
    document.getElementById('modelHanaBlock').hidden = source !== 'hana';
    document.getElementById('modelCustomBlock').hidden = source !== 'custom';
    modelTestResult.textContent = '';
  }

  function updateModelOptions(selectedModel) {
    modelModel.innerHTML = '<option value="">选择模型...</option>';
    for (var i = 0; i < modelCatalog.length; i++) {
      if (modelCatalog[i].providerId !== modelProvider.value) continue;
      var models = modelCatalog[i].models || [];
      for (var j = 0; j < models.length; j++) {
        var option = document.createElement('option');
        option.value = models[j].id;
        option.textContent = models[j].name || models[j].id;
        modelModel.appendChild(option);
      }
      break;
    }
    if (selectedModel) modelModel.value = selectedModel;
  }

  function populateModelOptions(selectedProvider, selectedModel) {
    modelProvider.innerHTML = '<option value="">选择供应商...</option>';
    for (var i = 0; i < modelCatalog.length; i++) {
      var provider = modelCatalog[i];
      var option = document.createElement('option');
      option.value = provider.providerId;
      option.textContent = provider.providerName + '（' + provider.models.length + ' 个文本模型）';
      modelProvider.appendChild(option);
    }
    modelProvider.value = selectedProvider || '';
    updateModelOptions(selectedModel);
    if (!modelCatalog.length) {
      modelCatalogHint.textContent = 'Hana 当前没有可选的文本模型；可以切换到自定义 API。';
    } else {
      modelCatalogHint.textContent = '列表来自 Hana 当前可用的文本模型，不会把供应商密钥交给插件页面。';
    }
  }

  function renderModelSummary(config, agentName) {
    var text = '跟随' + (agentName || '当前助手');
    if (config.source === 'hana') {
      var found = false;
      for (var i = 0; i < modelCatalog.length; i++) {
        if (modelCatalog[i].providerId !== config.providerId) continue;
        var models = modelCatalog[i].models || [];
        var modelName = config.modelId;
        for (var j = 0; j < models.length; j++) {
          if (models[j].id === config.modelId) modelName = models[j].name || models[j].id;
        }
        text = 'Hana · ' + modelCatalog[i].providerName + ' / ' + modelName;
        found = true;
        break;
      }
      if (!found) text = 'Hana · ' + config.providerId + ' / ' + config.modelId;
    } else if (config.source === 'custom') {
      text = '自定义 API · ' + (config.customModel || '未填写模型');
    }
    modelDescription.textContent = text;
  }

  function applyModelData(payload) {
    var data = payload.data || payload;
    var config = data.config || { source: 'agent' };
    modelCatalog = data.models || [];
    modelSource.value = config.source || 'agent';
    populateModelOptions(config.providerId, config.modelId);
    modelCustomUrl.value = config.customBaseUrl || '';
    modelCustomKey.value = config.customApiKey ? '********' : '';
    modelCustomModel.value = config.customModel || '';
    updateModelSourceBlocks();
    renderModelSummary(config, data.agentName);
  }

  function buildModelConfig() {
    return {
      source: modelSource.value,
      providerId: modelSource.value === 'hana' ? modelProvider.value : '',
      modelId: modelSource.value === 'hana' ? modelModel.value : '',
      customBaseUrl: modelSource.value === 'custom' ? modelCustomUrl.value.trim() : '',
      customApiKey: modelSource.value === 'custom' ? modelCustomKey.value : '',
      customModel: modelSource.value === 'custom' ? modelCustomModel.value.trim() : '',
    };
  }

  function modelApi(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
        return data;
      });
    });
  }

  updateModelSourceBlocks();
  document.getElementById('modelButton').addEventListener('click', function () {
    modelModal.classList.add('show');
    modelTestResult.textContent = '正在读取 Hana 模型列表…';
    api('api/model-config')
      .then(function (response) {
        if (!response.ok) throw new Error('读取模型列表失败');
        return response.json();
      })
      .then(function (data) {
        if (!data.ok) throw new Error(data.error || '读取模型列表失败');
        applyModelData(data);
        modelTestResult.textContent = '';
      })
      .catch(function (error) { modelTestResult.textContent = error.message || '读取失败'; });
  });
  modelSource.addEventListener('change', updateModelSourceBlocks);
  modelProvider.addEventListener('change', function () { updateModelOptions(''); });
  document.getElementById('modelTest').addEventListener('click', function () {
    var button = this;
    button.disabled = true;
    modelTestResult.textContent = '测试中…';
    modelApi('api/model-test', buildModelConfig())
      .then(function (data) {
        modelTestResult.textContent = '✓ ' + ((data.data && data.data.reply) || '连接成功');
      })
      .catch(function (error) { modelTestResult.textContent = '× ' + (error.message || '连接失败'); })
      .finally(function () { button.disabled = false; });
  });
  document.getElementById('modelSave').addEventListener('click', function () {
    var button = this;
    button.disabled = true;
    modelApi('api/model-config', buildModelConfig())
      .then(function (data) {
        var saved = data.data && data.data.config ? data.data.config : buildModelConfig();
        renderModelSummary(saved, '当前助手');
        showToast('模型配置已保存');
        closeModelModal();
      })
      .catch(function (error) { showToast(error.message || '模型配置保存失败'); })
      .finally(function () { button.disabled = false; });
  });
  document.getElementById('modelClose').addEventListener('click', closeModelModal);
  modelModal.addEventListener('click', function (event) {
    if (event.target === modelModal) closeModelModal();
  });

  // 页面加载：先读文案模型配置，让摘要行显示真实状态（含当前助手名）
  api('api/model-config')
    .then(function (response) {
      if (!response.ok) throw new Error('读取模型配置失败');
      return response.json();
    })
    .then(function (data) {
      if (!data.ok || !data.data) throw new Error('读取模型配置失败');
      modelCatalog = data.data.models || [];
      renderModelSummary(data.data.config || { source: 'agent' }, data.data.agentName);
    })
    .catch(function () {});

  // 页面加载：先读新成就角标（不展开面板）
  api('api/achievements')
    .then(function (response) {
      if (!response.ok) throw new Error('读取成就失败');
      return response.json();
    })
    .then(function (data) {
      var count = data && data.data ? Number(data.data.newCount) || 0 : 0;
      if (count > 0) {
        achBadge.textContent = count > 9 ? '9+' : String(count);
        achBadge.hidden = false;
      }
    })
    .catch(function () {});

  window.parent && window.parent.postMessage({
    protocol: 'hana.plugin.ui', version: 1, kind: 'event', type: 'hana.ready'
  }, '*');
})();
</script>
</body>
</html>`;
}

function renderOptions(key, title, presets, current, unit) {
  const customSelected = !presets.includes(current);
  const presetButtons = presets.map((value) =>
    `<button class="option${value === current ? " selected" : ""}" data-key="${key}" data-value="${value}" type="button">${formatOptionValue(value, unit)}</button>`
  ).join("");
  const customLabel = customSelected ? formatOptionValue(current, unit) : "自定义";
  return `<section class="group"><div class="group-title">${title}</div><div class="options">${presetButtons}<button class="option${customSelected ? " selected" : ""}" data-key="${key}" data-custom="1" type="button">${customLabel}</button></div></section>`;
}

function renderToggle(key, value, danger) {
  return `<div class="segment ${danger ? "danger" : ""}">
    <button class="toggle ${value ? "active" : ""}" data-toggle="${key}" data-bool="true">开</button>
    <button class="toggle ${!value ? "active" : ""}" data-toggle="${key}" data-bool="false">关</button>
  </div>`;
}
