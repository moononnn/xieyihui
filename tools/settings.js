// 歇一会 - 配置查询、修改与测试工具

import { state } from "./_lib/state.js";
import { restartTick, triggerBreakNow } from "./_lib/timer.js";

export const name = "rest_settings";
export const description = "查看或修改「歇一会」休息提醒的配置，也可以立即测试一次休息窗口。";
export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["get", "set", "test"], description: "get=查看, set=修改, test=立即测试" },
    workInterval: { type: "number", description: "工作间隔（分钟）" },
    breakDuration: { type: "number", description: "休息时长（秒）" },
    enableBreaks: { type: "boolean", description: "总开关" },
    forceMode: { type: "boolean", description: "强制模式，跳过按钮会触发实时劝阻" },
    pauseOnFullscreen: { type: "boolean", description: "全屏（视频/游戏）时暂停计时" },
    pauseOnAway: { type: "boolean", description: "暂离（长时间无操作）时暂停计时" },
    awayThresholdMinutes: { type: "number", description: "暂离判定阈值（分钟）" },
  },
  required: ["action"],
};

export async function execute(input, ctx) {
  if (input.action === "get") {
    return asText({
      ok: true,
      config: { ...state.config },
      currentState: { phase: state.phase, skippedCount: state.skippedCount },
    });
  }

  if (input.action === "test") {
    const started = await triggerBreakNow();
    return asText({ ok: started, message: started ? "已触发休息窗口" : "休息窗口已经打开" });
  }

  if (input.action !== "set") return asText({ ok: false, error: "未知操作" });

  const partial = {};
  for (const key of ["workInterval", "breakDuration", "enableBreaks", "forceMode", "pauseOnFullscreen", "pauseOnAway", "awayThresholdMinutes"]) {
    if (input[key] !== undefined) partial[key] = input[key];
  }
  if (!Object.keys(partial).length) return asText({ ok: false, error: "没有要修改的配置项" });

  for (const key of ["workInterval", "breakDuration", "awayThresholdMinutes"]) {
    if (partial[key] !== undefined) {
      const value = Number(partial[key]);
      if (!Number.isFinite(value) || value < 1) return asText({ ok: false, error: `${key} 必须大于 0` });
      partial[key] = Math.round(value);
    }
  }
  if (partial.enableBreaks !== undefined) partial.enableBreaks = Boolean(partial.enableBreaks);
  if (partial.forceMode !== undefined) partial.forceMode = Boolean(partial.forceMode);
  if (partial.pauseOnFullscreen !== undefined) partial.pauseOnFullscreen = Boolean(partial.pauseOnFullscreen);
  if (partial.pauseOnAway !== undefined) partial.pauseOnAway = Boolean(partial.pauseOnAway);
  state.config = { ...state.config, ...partial };

  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const filePath = path.join(state.dataDir || ctx.dataDir, state.pluginId || ctx.pluginId, "config.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state.config, null, 2), "utf-8");
  } catch (error) {
    return asText({ ok: false, error: "保存失败: " + error.message });
  }

  restartTick();
  return asText({ ok: true, updated: Object.keys(partial), config: state.config });
}

function asText(value) {
  return JSON.stringify(value, null, 2);
}
