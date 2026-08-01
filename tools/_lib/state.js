// 歇一会 - 共享运行时状态
// 所有模块通过 import 此模块共享同一份状态

const DEFAULT_CONFIG = {
  workInterval: 30,       // 工作间隔（分钟）
  breakDuration: 20,      // 休息时长（秒）
  enableBreaks: true,     // 总开关
  forceMode: false,       // 强制模式（跳过按钮变为实时劝阻）
  pauseOnFullscreen: true, // 全屏（视频/游戏）时暂停计时
  pauseOnAway: true,      // 暂离（长时间无操作）时暂停计时
  awayThresholdMinutes: 5, // 暂离判定阈值（分钟）
};

const STATES = Object.freeze({
  WORKING: "working",
  READY: "break-ready",   // 即将休息（未来扩展用）
  BREAKING: "breaking",
  IDLE: "idle"
});

const state = {
  phase: STATES.IDLE,
  config: { ...DEFAULT_CONFIG },
  skippedCount: 0,
  pauseReason: null, // 计时暂停原因：fullscreen / dnd / away / null
  dataDir: null,
  pluginId: null,
  ctx: null
};

export { DEFAULT_CONFIG, STATES, state };
