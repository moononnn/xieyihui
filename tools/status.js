// 歇一会 - 状态查询工具

import { state } from "./_lib/state.js";

export const name = "rest_status";
export const description = "查看「歇一会」休息提醒的当前状态。";
export const parameters = { type: "object", properties: {}, required: [] };

export async function execute() {
  const labels = {
    working: "工作中",
    "break-ready": "即将休息",
    breaking: "休息中",
    idle: "已暂停",
  };
  const pauseLabels = {
    fullscreen: "全屏中（看视频/玩游戏），计时暂停",
    dnd: "免打扰模式，计时暂停",
    away: "暂离中，计时暂停",
  };
  return JSON.stringify({
    ok: true,
    phase: state.phase,
    phaseLabel: labels[state.phase] || "未知",
    pauseReason: state.pauseReason,
    pauseLabel: state.pauseReason ? (pauseLabels[state.pauseReason] || "计时暂停中") : null,
    config: { ...state.config },
    skippedCount: state.skippedCount,
  }, null, 2);
}
