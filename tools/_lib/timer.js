// 歇一会 - 后台计时、全屏弹窗、实时回复桥、欠账与成就结算

import { state, STATES, DEFAULT_CONFIG } from "./state.js";
import {
  buildReplyBatchPrompt,
  EFFECT_TYPES,
  makePoolPickers,
  messagesToContext,
  parseReplyBatchByType,
  pickActiveAgent,
  pickFallbackReply,
  pickSessionForAgent,
  resetFallbackPickers,
} from "./replies.js";
import {
  appendToArchive,
  loadArchive,
  pickFromArchive,
  resetArchivePickers,
  saveArchive,
} from "./archive.js";
import {
  loadRecords,
  settleEscape,
  settleRest,
  saveRecords,
} from "./records.js";
import { cleanReplyText } from "./replies.js";
import { extractModelText, readModelConfig, sampleConfiguredModel } from "./model-config.js";
import { spawn, spawnSync } from "node:child_process";
import { writeJsonAtomic } from "./fsutil.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

let tickTimer = null;
let replyPollTimer = null;
let refreshTimer = null;
let envTimer = null;
let breakProcess = null;
let breakPending = false;
let breakCheckPending = false;
let started = false;
// 周期环境检测缓存：全屏 / 免打扰 / 鼠标键盘空闲秒数
let envState = { fullscreen: false, dnd: false, idleSeconds: 0, checkedAt: 0 };
let replyQueue = Promise.resolve();
let activeBreakContext = null;
let replyPool = { reply: [], move: [], extend: [], stall: [] };
let replyPoolPickers = null;
let replyPoolPromise = null;
let replyPoolGeneration = 0;
let replyPoolContextKey = "";
let ipcDir = "";
let activeWindowId = null;
let windowStartAt = 0;
let activeDebtPaid = 0;
const settledWindowIds = new Set();
const SETTLED_MAX = 50; // 已结算窗口 ID 容量上限，超出后清掉最旧的一半
let pythonCmd = null;   // Python 命令探测结果缓存：{ cmd, prefix }
let cachedUserName = null; // Hana 配置里的用户名缓存（空字符串也算命中，避免重复读文件）
let records = null;
let archive = {};

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const REQUEST_RE = /^request-(.+)\.json$/;
const SUMMARY_RE = /^summary-(.+)\.json$/;
const MODEL_TIMEOUT_MS = 20000;
const BUS_TIMEOUT_MS = 8000;
const IPC_STALE_MS = 60000;
const PREFETCH_COUNT_PER_TYPE = 2;
const PREPARE_BEFORE_SECONDS = 45;
const REFRESH_INTERVAL_MS = 120000; // 休息期间每 2 分钟补一批文案，避免审美疲劳
const ENV_CHECK_INTERVAL_MS = 5000; // 环境检测频率：全屏/暂离最多滞后 5 秒识别

export function start(ctx) {
  if (started) return;
  started = true;
  state.ctx = ctx;
  state.dataDir = ctx.dataDir;
  state.pluginId = ctx.pluginId;
  ipcDir = path.join(ctx.dataDir, ctx.pluginId, "reply-ipc");
  loadConfig();
  ensureIpcDir();
  records = loadRecords(ctx.dataDir, ctx.pluginId);
  archive = loadArchive(ctx.dataDir, ctx.pluginId);
  if (state.config.enableBreaks) {
    state.phase = STATES.WORKING;
    startTick();
    startEnvMonitor();
  }
  ctx.log?.info?.("歇一会已启动", {
    workInterval: state.config.workInterval,
    breakDuration: state.config.breakDuration,
    forceMode: state.config.forceMode,
    python: resolvePython().cmd,
  });
}

export function restartTick() {
  if (state.config.enableBreaks) {
    state.phase = STATES.WORKING;
    startTick();
    startEnvMonitor();
  } else {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    state.phase = STATES.IDLE;
    stopEnvMonitor();
  }
}

export function stop() {
  if (tickTimer) clearInterval(tickTimer);
  if (replyPollTimer) clearInterval(replyPollTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  if (envTimer) clearInterval(envTimer);
  if (breakProcess) breakProcess.kill();
  tickTimer = null;
  replyPollTimer = null;
  refreshTimer = null;
  envTimer = null;
  breakProcess = null;
  breakPending = false;
  breakCheckPending = false;
  activeBreakContext = null;
  state.pauseReason = null;
  clearReplyPool();
  replyQueue = Promise.resolve();
  started = false;
}

export async function triggerBreakNow() {
  if (breakProcess || breakPending) return false;
  state.phase = STATES.BREAKING;
  const spawned = await spawnBreakWindow();
  if (!spawned) state.phase = STATES.WORKING;
  return spawned;
}

export async function sendPreBreakNotify() {
  clearReplyPool();
  activeBreakContext = await resolveActiveContext();
  activeBreakContext.history = await readRecentHistory(activeBreakContext.session?.path);
  prepareReplyPool(activeBreakContext);
}

/**
 * 探测可用的 Python 命令（Windows 上 python / python3 / py -3 不确定哪个存在）。
 * 结果缓存；全部失败时兑底用 python，让 spawn 的 error 事件暴露问题。
 */
function resolvePython() {
  if (pythonCmd) return pythonCmd;
  const candidates = [
    ["python", []],
    ["python3", []],
    ["py", ["-3"]],
  ];
  for (const [cmd, prefix] of candidates) {
    try {
      const result = spawnSync(cmd, [...prefix, "-c", "import sys; sys.exit(0)"], { timeout: 3000 });
      if (result.status === 0) {
        pythonCmd = { cmd, prefix };
        return pythonCmd;
      }
    } catch {
      // 命令不存在或启动失败，试下一个
    }
  }
  pythonCmd = { cmd: "python", prefix: [] };
  return pythonCmd;
}

function pySpawn(args, options) {
  const py = resolvePython();
  return spawn(py.cmd, [...py.prefix, ...args], options);
}

/**
 * 从 Hana 全局配置读用户名（user/preferences.json 的 userName），
 * 读不到时用中性的「你」兑底，不硬编码任何具体名字。
 */
function readUserName() {
  if (cachedUserName !== null) return cachedUserName;
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(HANA_HOME, "user", "preferences.json"), "utf-8"));
    cachedUserName = String(prefs.userName || "").trim() || "你";
  } catch {
    cachedUserName = "你";
  }
  return cachedUserName;
}

export function sendPreBreakToast() {
  const toastPy = path.join(state.ctx.pluginDir, "python", "toast.py");
  // 助手名取当前活跃助手（提前 45 秒预取的上下文），读不到时兑底插件名
  const agentName = activeBreakContext?.agent?.name || "歇一会";
  const title = `${agentName} 提醒 ${readUserName()}`;
  pySpawn([toastPy, title, "还有 10 秒就到休息时间了~"], { stdio: "ignore" });
}

/**
 * 是否应该暂停计时。纯函数，便于测试。
 * 返回暂停原因：dnd（免打扰，无条件） / fullscreen（全屏） / away（暂离） / null（正常计时）
 */
export function shouldPause(config, env) {
  if (!config || !env) return null;
  if (env.dnd) return "dnd";
  if (config.pauseOnFullscreen && env.fullscreen) return "fullscreen";
  if (config.pauseOnAway) {
    const thresholdSec = (Number(config.awayThresholdMinutes) || 0) * 60;
    if (thresholdSec > 0 && env.idleSeconds >= thresholdSec) return "away";
  }
  return null;
}

/** 周期环境检测：每几秒跑一次 detect_state.py，结果缓存到 envState */
function startEnvMonitor() {
  stopEnvMonitor();
  checkEnvState();
  envTimer = setInterval(checkEnvState, ENV_CHECK_INTERVAL_MS);
}

function stopEnvMonitor() {
  if (envTimer) clearInterval(envTimer);
  envTimer = null;
}

function checkEnvState() {
  const script = path.join(state.ctx.pluginDir, "python", "detect_state.py");
  const proc = pySpawn([script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const apply = () => {
    try {
      const parsed = JSON.parse(output.trim());
      envState = {
        fullscreen: Boolean(parsed.fullscreen),
        dnd: Boolean(parsed.dnd),
        idleSeconds: Number(parsed.idleSeconds) || 0,
        checkedAt: Date.now(),
      };
    } catch {
      // 解析失败：保留旧状态，宁可多等一轮也不误暂停
    }
  };
  proc.once("close", (code) => { if (code === 0) apply(); });
  proc.once("error", () => {});
}

/** 到点临门检测发现全屏/免打扰时，把结果同步进缓存，让 tick 的暂停逻辑接管等待 */
function syncEnvFromCheckOutput(output) {
  const fsMatch = /fullscreen=(true|false)/.exec(output);
  if (fsMatch) envState.fullscreen = fsMatch[1] === "true";
  const dndMatch = /dnd=(true|false)/.exec(output);
  if (dndMatch) envState.dnd = dndMatch[1] === "true";
  envState.checkedAt = Date.now();
}

function startTick() {
  if (tickTimer) clearInterval(tickTimer);
  let workSeconds = 0;

  tickTimer = setInterval(() => {
    if (!state.config.enableBreaks) {
      state.phase = STATES.IDLE;
      return;
    }
    if (state.phase !== STATES.WORKING) return;

    // 环境暂停：全屏 / 免打扰 / 暂离期间冻结计时，不提醒、不弹窗
    const pauseReason = shouldPause(state.config, envState);
    state.pauseReason = pauseReason;
    if (pauseReason) return;

    workSeconds += 1;
    const targetSec = state.config.workInterval * 60;
    if (workSeconds === targetSec - PREPARE_BEFORE_SECONDS && targetSec > PREPARE_BEFORE_SECONDS) {
      void sendPreBreakNotify();
    }
    if (workSeconds === targetSec - 10 && targetSec > 10) sendPreBreakToast();
    if (workSeconds >= targetSec && !breakCheckPending) {
      breakCheckPending = true;
      void maybeSpawnBreakWindow().then((verdict) => {
        breakCheckPending = false;
        if (verdict === "deferred") {
          // 全屏/免打扰中：保持到点附近，等环境恢复后留 10 秒缓冲再提醒、弹窗
          workSeconds = Math.max(0, targetSec - 11);
        } else {
          workSeconds = 0;
        }
      });
    }
  }, 1000);
}

async function maybeSpawnBreakWindow() {
  if (breakProcess || breakPending || state.phase !== STATES.WORKING) return "busy";
  const checker = path.join(state.ctx.pluginDir, "python", "check_env.py");
  const proc = pySpawn([checker], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk.toString(); });

  const verdict = await new Promise((resolve) => {
    const finishCheck = (code, error = null) => {
      if (error) {
        state.ctx?.log?.warn?.("环境检测失败，仍然弹出休息窗口", { error: error.message });
        resolve("go");
      } else if (code !== 0) {
        // 全屏/免打扰：不跳过本轮，把环境状态同步进缓存，由 tick 的暂停逻辑等待恢复
        syncEnvFromCheckOutput(output);
        state.ctx?.log?.info?.("检测到全屏或免打扰，等待环境恢复后再休息", { output: output.trim() });
        activeBreakContext = null;
        clearReplyPool();
        resolve("deferred");
      } else {
        resolve("go");
      }
    };
    proc.once("close", (code) => { finishCheck(code); });
    proc.once("error", (error) => { finishCheck(null, error); });
  });

  if (verdict !== "go") return verdict;
  state.phase = STATES.BREAKING;
  const spawned = await spawnBreakWindow();
  if (!spawned) state.phase = STATES.WORKING;
  return spawned ? "spawned" : "busy";
}

async function spawnBreakWindow() {
  if (breakProcess || breakPending) return false;
  breakPending = true;
  ensureIpcDir();
  cleanStaleIpcFiles();
  resetArchivePickers(); // 新一轮休息：档案“本轮已抽”标记清零
  resetFallbackPickers(); // 新一轮休息：写死兜底“本轮已用”记忆清零
  activeBreakContext = await prepareBreakContextForWindow();
  prepareReplyPool(activeBreakContext);

  // 欠账补还：上次逃逸欠下的秒数，这次直接加进休息时长
  if (!records) records = loadRecords(state.dataDir, state.pluginId);
  activeDebtPaid = records.debtSeconds || 0;
  const duration = state.config.breakDuration + activeDebtPaid;

  const pyScript = path.join(state.ctx.pluginDir, "python", "fullscreen_test.py");
  const agent = activeBreakContext.agent;
  activeWindowId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  windowStartAt = Date.now();
  const args = [
    pyScript,
    "--duration", String(duration),
    "--debt", String(activeDebtPaid),
    "--window-id", activeWindowId,
    "--agent-name", agent.name,
    "--agent-id", agent.id,
    "--ipc-dir", ipcDir,
  ];
  if (agent.avatarPath) args.push("--agent-avatar", agent.avatarPath);
  if (state.config.forceMode) args.push("--force");

  state.ctx?.log?.info?.("启动全屏休息窗口", {
    agentId: agent.id,
    agentName: agent.name,
    duration,
    debtPaid: activeDebtPaid,
    hasSession: Boolean(activeBreakContext.session?.path),
  });

  try {
    startReplyBridge();
    startRefreshTimer();
    breakProcess = pySpawn(args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
    breakPending = false;
    breakProcess.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) state.ctx?.log?.warn?.("休息窗口输出", { message });
    });
    breakProcess.on("exit", (code) => {
      if (code === 1) state.skippedCount += 1;
      else state.skippedCount = 0;
      state.phase = STATES.WORKING;
      breakProcess = null;
      settleWindowOnExit(code);
      activeBreakContext = null;
      clearReplyPool();
      stopReplyBridge();
      stopRefreshTimer();
    });
    breakProcess.on("error", (error) => {
      state.ctx?.log?.error?.("启动全屏窗口失败", { error: error.message });
      state.phase = STATES.WORKING;
      breakProcess = null;
      breakPending = false;
      activeBreakContext = null;
      clearReplyPool();
      stopReplyBridge();
      stopRefreshTimer();
    });
    return true;
  } catch (error) {
    state.ctx?.log?.error?.("启动全屏窗口异常", { error: error.message });
    state.phase = STATES.WORKING;
    breakProcess = null;
    breakPending = false;
    activeBreakContext = null;
    clearReplyPool();
    stopReplyBridge();
    stopRefreshTimer();
    return false;
  }
}

/** 窗口退出后的兜底结算：结算请求已处理过的窗口跳过，防止重复计数 */
function settleWindowOnExit(exitCode) {
  const summary = readLatestSummary();
  if (!summary || settledWindowIds.has(summary.windowId)) return;
  const durationSec = Math.round((Date.now() - windowStartAt) / 1000);
  const event = {
    windowId: summary.windowId,
    skips: Number(summary.skips) || 0,
    evades: Number(summary.evades) || 0,
    confiscates: Number(summary.confiscates) || 0,
    extraSeconds: Number(summary.extraSeconds) || 0,
    durationSec: Number(summary.durationSec) || durationSec,
    struggle: Boolean(summary.struggle),
  };
  if (summary.action === "completed" || exitCode === 0) {
    settleRest(state.dataDir, state.pluginId, records, { ...event, paidSeconds: activeDebtPaid });
  } else {
    settleEscape(state.dataDir, state.pluginId, records, event);
  }
  markSettledWindow(summary.windowId);
  try {
    const summaryPath = path.join(ipcDir, `summary-${summary.windowId}.json`);
    if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath);
  } catch {}
}

/** 记录已结算窗口 ID；超容量后清掉最旧的一半（Set 按插入序迭代） */
function markSettledWindow(windowId) {
  if (!windowId) return;
  settledWindowIds.add(windowId);
  if (settledWindowIds.size <= SETTLED_MAX) return;
  const dropCount = settledWindowIds.size - Math.floor(SETTLED_MAX / 2);
  let dropped = 0;
  for (const id of settledWindowIds) {
    if (dropped >= dropCount) break;
    settledWindowIds.delete(id);
    dropped += 1;
  }
}

function readLatestSummary() {
  if (!activeWindowId) return null;
  try {
    const summaryPath = path.join(ipcDir, `summary-${activeWindowId}.json`);
    if (!fs.existsSync(summaryPath)) return null;
    return JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
  } catch {
    return null;
  }
}

function startRefreshTimer() {
  stopRefreshTimer();
  refreshTimer = setInterval(() => {
    if (!activeBreakContext) return;
    prepareReplyPool(activeBreakContext, { force: true });
  }, REFRESH_INTERVAL_MS);
}

function stopRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function ensureIpcDir() {
  fs.mkdirSync(ipcDir, { recursive: true });
}

function cleanStaleIpcFiles(now = Date.now()) {
  for (const name of fs.readdirSync(ipcDir)) {
    if (!/^(request|response|summary)-/.test(name) && !name.endsWith(".processing") && !name.endsWith(".tmp")) continue;
    const filePath = path.join(ipcDir, name);
    try {
      if (now - fs.statSync(filePath).mtimeMs > IPC_STALE_MS) fs.unlinkSync(filePath);
    } catch {}
  }
}

function startReplyBridge() {
  if (replyPollTimer) clearInterval(replyPollTimer);
  replyPollTimer = setInterval(scanReplyRequests, 120);
}

function stopReplyBridge() {
  if (replyPollTimer) clearInterval(replyPollTimer);
  replyPollTimer = null;
}

function scanReplyRequests() {
  if (!activeBreakContext || !fs.existsSync(ipcDir)) return;
  const names = fs.readdirSync(ipcDir).filter((name) => REQUEST_RE.test(name)).sort();
  for (const name of names) {
    const requestPath = path.join(ipcDir, name);
    const processingPath = requestPath + ".processing";
    try {
      fs.renameSync(requestPath, processingPath);
    } catch {
      continue;
    }
    replyQueue = replyQueue
      .then(() => processReplyRequest(processingPath))
      .catch((error) => state.ctx?.log?.error?.("实时回复队列异常", { error: error.message }));
  }
}

async function processReplyRequest(processingPath) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(processingPath, "utf-8"));
  } catch (error) {
    state.ctx?.log?.warn?.("读取实时回复请求失败", { error: error.message });
    try { fs.unlinkSync(processingPath); } catch {}
    return;
  }

  const requestId = String(request.requestId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!requestId) {
    try { fs.unlinkSync(processingPath); } catch {}
    return;
  }

  // 结算请求：休息完成，给夸夸 + 成就
  if (request.action === "completed") {
    const durationSec = Math.max(0, Number(request.durationSec) || 0);
    const event = {
      windowId: String(request.windowId || activeWindowId || ""),
      skips: Number(request.skips) || 0,
      evades: Number(request.evades) || 0,
      confiscates: Number(request.confiscates) || 0,
      extraSeconds: Number(request.extraSeconds) || 0,
      durationSec,
      paidSeconds: activeDebtPaid,
      struggle: Number(request.skips) > 0 || Number(request.evades) > 0,
    };
    const result = settleRest(state.dataDir, state.pluginId, records, event);
    if (event.windowId) markSettledWindow(event.windowId);
    const first = result.newAchievements[0] || null;
    const achievementName = first
      ? (first.tierName ? `${first.tierName}·${first.name}` : first.name)
      : "";
    const response = {
      ok: true,
      requestId,
      text: achievementName
        ? `${achievementName} 达成！${result.praise}`
        : result.praise,
      achievement: achievementName,
    };
    writeJsonAtomic(path.join(ipcDir, `response-${requestId}.json`), response);
    try { fs.unlinkSync(processingPath); } catch {}
    return;
  }

  const context = activeBreakContext || {
    agent: {
      id: request.agentId || "",
      name: request.agentName || "当前助手",
    },
  };
  const effect = EFFECT_TYPES.includes(request.effect) ? request.effect : "reply";
  const prefetched = takePrefetchedReply(effect, context.agent.id);
  const text = prefetched
    || pickFromArchive(archive, context.agent.id, effect)
    || pickFallbackReply(context.agent.id, effect);
  const response = {
    ok: true,
    requestId,
    text,
    source: prefetched ? "prefetched" : (text ? "archive-or-fallback" : "fallback"),
    agentId: context.agent.id,
    agentName: context.agent.name,
  };

  writeJsonAtomic(path.join(ipcDir, `response-${requestId}.json`), response);
  try { fs.unlinkSync(processingPath); } catch {}
}

async function prepareBreakContextForWindow() {
  const latest = await resolveActiveContext(activeBreakContext);
  const latestKey = getContextKey(latest);
  const preparedKey = getContextKey(activeBreakContext);
  if (!activeBreakContext || latestKey !== preparedKey) {
    clearReplyPool();
    activeBreakContext = latest;
    activeBreakContext.history = await readRecentHistory(activeBreakContext.session?.path);
  } else {
    activeBreakContext = {
      ...activeBreakContext,
      agent: latest.agent,
      session: latest.session,
    };
  }
  return activeBreakContext;
}

function getContextKey(context) {
  if (!context?.agent) return "";
  return `${context.agent.id || ""}|${context.session?.path || ""}`;
}

function clearReplyPool() {
  replyPool = { reply: [], move: [], extend: [], stall: [] };
  replyPoolPickers = null;
  replyPoolPromise = null;
  replyPoolContextKey = "";
  replyPoolGeneration += 1;
}

/**
 * 预生成休息文案（按类型），成功时并入池子并追加进台词档案。
 * force=true 时绕过进行中的生成（休息期间的定时补充用）。
 */
function prepareReplyPool(context, { force = false } = {}) {
  if (!context || (replyPoolPromise && !force)) return;
  const generation = replyPoolGeneration;
  const contextKey = getContextKey(context);
  const work = (async () => {
    try {
      const history = context.history || await readRecentHistory(context.session?.path);
      const prompt = buildReplyBatchPrompt({
        agentId: context.agent.id,
        agentName: context.agent.name,
        identity: context.agent.identity,
        context: history,
        countPerType: PREFETCH_COUNT_PER_TYPE,
      });
      state.ctx?.log?.info?.("开始预生成休息文案", {
        agentId: context.agent.id,
        countPerType: PREFETCH_COUNT_PER_TYPE,
      });
      const raw = await sampleReply(
        prompt,
        context,
        "（休息窗口即将打开，请先准备后续劝休息用语）",
        false,
        800
      );
      const grouped = parseReplyBatchByType(raw, PREFETCH_COUNT_PER_TYPE);
      if (generation !== replyPoolGeneration) return;
      const total = EFFECT_TYPES.reduce((sum, effect) => sum + grouped[effect].length, 0);
      if (!total) return;
      if (!replyPoolPickers) replyPoolPickers = makePoolPickers(replyPool);
      for (const effect of EFFECT_TYPES) {
        // 抽走即移除的池子：只补充新文案，不重建（重建会把已展示过的又放回来）
        replyPoolPickers.refill(effect, grouped[effect]);
        appendToArchive(archive, context.agent.id, effect, grouped[effect]);
      }
      replyPoolContextKey = contextKey;
      saveArchive(state.dataDir, state.pluginId, archive);
      state.ctx?.log?.info?.("休息文案预生成完成", { total, agentId: context.agent.id });
    } catch (error) {
      state.ctx?.log?.warn?.("预生成休息文案失败，使用本地兜底", { error: error.message });
    }
  })();
  replyPoolPromise = work;
  void work.finally(() => {
    if (replyPoolPromise === work) replyPoolPromise = null;
  }).catch(() => {});
}

function takePrefetchedReply(effect, agentId) {
  if (!replyPoolPickers || replyPoolContextKey.split("|")[0] !== agentId) return "";
  return replyPoolPickers.take(effect) || "";
}

async function resolveActiveContext(previous = null) {
  const [agentResult, sessionResult] = await Promise.allSettled([
    withTimeout(state.ctx.bus.request("agent:list", {}), BUS_TIMEOUT_MS, "读取助手超时"),
    withTimeout(state.ctx.bus.request("session:list", {}), BUS_TIMEOUT_MS, "读取会话超时"),
  ]);
  const agentsLoaded = agentResult.status === "fulfilled";
  const sessionsLoaded = sessionResult.status === "fulfilled";
  const agents = agentsLoaded && Array.isArray(agentResult.value?.agents) ? agentResult.value.agents : [];
  const sessions = sessionsLoaded && Array.isArray(sessionResult.value?.sessions) ? sessionResult.value.sessions : [];

  if (!agentsLoaded) {
    state.ctx?.log?.warn?.("读取当前助手失败，暂时沿用上一次身份", { error: agentResult.reason?.message || "未知错误" });
  }
  if (!sessionsLoaded) {
    state.ctx?.log?.warn?.("读取会话失败，本次不更新对话上下文", { error: sessionResult.reason?.message || "未知错误" });
  }

  const pickedAgent = agentsLoaded
    ? pickActiveAgent(agents, sessionsLoaded ? sessions : [])
    : (previous?.agent || { id: "", name: "当前助手", identity: "" });
  const agentId = pickedAgent.id || "";
  const freshSession = agentId && sessionsLoaded ? pickSessionForAgent(sessions, agentId) : null;
  const previousSession = !sessionsLoaded && previous?.agent?.id === agentId ? previous.session : null;
  const agent = {
    id: agentId,
    name: pickedAgent.name || "当前助手",
    identity: pickedAgent.identity || "",
    avatarPath: findAvatarPath(agentId),
  };
  return { agent: { ...agent }, session: freshSession ? { ...freshSession } : (previousSession ? { ...previousSession } : null) };
}

function findAvatarPath(agentId) {
  const safeAgentId = path.basename(String(agentId || "").trim());
  if (!safeAgentId) return "";
  const avatarDir = path.join(HANA_HOME, "agents", safeAgentId, "avatars");
  const preferred = ["agent.png", "agent.webp", "agent.jpg", "agent.jpeg"];
  for (const name of preferred) {
    const candidate = path.join(avatarDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const candidate = fs.readdirSync(avatarDir)
      .filter((name) => /\.(?:png|webp|jpe?g)$/i.test(name))
      .map((name) => ({ path: path.join(avatarDir, name), mtime: fs.statSync(path.join(avatarDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    return candidate?.path || "";
  } catch {
    return "";
  }
}

async function readRecentHistory(sessionPath) {
  if (!sessionPath) return "";
  try {
    const result = await withTimeout(
      state.ctx.bus.request("session:history", { sessionPath, limit: 10 }),
      BUS_TIMEOUT_MS,
      "读取会话上下文超时"
    );
    return messagesToContext(Array.isArray(result?.messages) ? result.messages : []);
  } catch (error) {
    state.ctx?.log?.warn?.("读取会话上下文失败", { error: error.message });
    return "";
  }
}

async function sampleReply(
  prompt,
  context,
  userContent = "（屏幕前的人又点了一次跳过休息）",
  clean = true,
  maxTokens = 160,
) {
  const input = {
    operation: "xieyihui-force-reply",
    agentId: context.agent.id,
    sessionPath: context.session?.path,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userContent },
    ],
    maxTokens,
    temperature: 0.9,
  };

  // 按模型配置分派：agent（跟随当前助手，Hana 每次动态解析）/ hana（指定 provider+model）/ custom（自定义 API）
  const config = readModelConfig(state.dataDir, state.pluginId);
  const call = sampleConfiguredModel(state.ctx, config, input, MODEL_TIMEOUT_MS);
  const result = await withTimeout(call, MODEL_TIMEOUT_MS);
  const raw = extractModelText(result);
  return clean ? cleanReplyText(raw) : String(raw || "");
}

export function sampleCurrentAgentModel(ctx, input, timeoutMs = MODEL_TIMEOUT_MS) {
  return ctx.bus.request("utility:call-text", input, { timeoutMs });
}

function withTimeout(promise, timeoutMs, message = "模型回复超时") {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(state.dataDir, state.pluginId, "config.json"), "utf-8"));
    state.config = { ...DEFAULT_CONFIG, ...saved };
  } catch {
    state.config = { ...DEFAULT_CONFIG };
  }
}
