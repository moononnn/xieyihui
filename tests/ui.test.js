import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import registerRoutes from "../routes/rest.js";
import { sampleCurrentAgentModel, stop as stopTimer } from "../tools/_lib/timer.js";

const routeSource = fs.readFileSync(path.join(process.cwd(), "routes", "rest.js"), "utf8");
const timerSource = fs.readFileSync(path.join(process.cwd(), "tools", "_lib", "timer.js"), "utf8");
const manifestSource = fs.readFileSync(path.join(process.cwd(), "manifest.json"), "utf8");

test("设置页最终生成的客户端脚本语法正确", () => {
  const dataDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-ui-test-"));
  const gets = new Map();
  const app = {
    get(route, handler) { gets.set(route, handler); },
    post() {},
  };
  try {
    registerRoutes(app, {
      pluginId: "xieyihui",
      pluginDir: process.cwd(),
      dataDir,
      bus: { request: async () => ({}) },
      log: {},
    });
    const html = gets.get("/page")({ html: (value) => value });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    assert.ok(scripts.length > 0, "页面应包含客户端脚本");
    for (const script of scripts) new Function(script);
  } finally {
    stopTimer();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("当前助手模型由 Hana 按 agentId 和 sessionPath 自动解析", async () => {
  let requestArgs = null;
  const ctx = {
    bus: {
      request: async (...args) => {
        requestArgs = args;
        return { text: "宿主回复" };
      },
    },
  };
  const input = {
    agentId: "agent-a",
    sessionPath: "sessions/demo.jsonl",
    messages: [{ role: "user", content: "准备休息文案" }],
  };
  const result = await sampleCurrentAgentModel(ctx, input, 1000);
  assert.equal(result.text, "宿主回复");
  assert.equal(requestArgs[0], "utility:call-text");
  assert.equal(requestArgs[1].agentId, "agent-a");
  assert.equal(requestArgs[1].sessionPath, "sessions/demo.jsonl");
  assert.deepEqual(requestArgs[2], { timeoutMs: 1000 });
});

test("分享版保留模型配置：自动跟随 + Hana 列表选择 + 自定义 API + 测试入口", () => {
  // timer 按模型配置分派
  assert.match(timerSource, /utility:call-text/);
  assert.match(timerSource, /readModelConfig/);
  assert.match(timerSource, /sampleConfiguredModel/);
  // 设置页有配置入口与弹窗
  assert.match(routeSource, /文案模型/);
  assert.match(routeSource, /modelButton/);
  assert.match(routeSource, /modelModal/);
  assert.match(routeSource, /modelSource/);
  assert.match(routeSource, /modelCustom/);
  assert.match(routeSource, /modelTest/);
  assert.match(routeSource, /model-config/);
  assert.match(routeSource, /model-test/);
  // 自定义 API 的 Key 处理与脱敏
  assert.match(routeSource, /API Key/);
  assert.match(routeSource, /customApiKey/);
  // 分享版仍不允许"立即测试全屏提醒"
  assert.doesNotMatch(routeSource, /test-trigger|testButton|立即测试全屏提醒/);
  // manifest 声明网络权限（自定义 API 直连用）
  assert.match(manifestSource, /network\.fetch/);
  assert.match(manifestSource, /allowedHosts/);
});

test("设置页 API 使用 plugin surface session", () => {
  assert.match(routeSource, /pluginSurfaceSession/);
  assert.match(routeSource, /X-Hana-Plugin-Surface-Session/);
  assert.match(routeSource, /path\.charAt\(0\)/);
  assert.doesNotMatch(routeSource, /tokenMatch/);
});

test("设置页包含成就按钮、展开面板与对应接口", () => {
  assert.match(routeSource, /app\.get\("\/api\/achievements"/);
  assert.match(routeSource, /app\.post\("\/api\/achievements-viewed"/);
  assert.match(routeSource, /id="achButton"/);
  assert.match(routeSource, /id="achModal"/);
  assert.match(routeSource, /id="achBadge"/);
  assert.match(routeSource, /斗智斗勇时长/);
  assert.match(routeSource, /总休息时长/);
  assert.match(routeSource, /ach-card/);
  assert.match(routeSource, /tier-bar/);
  assert.match(routeSource, /ach-title-tag/);
  assert.match(routeSource, /称号/);
  assert.match(routeSource, /fmtDuration/);
  assert.match(routeSource, /var ICONS = /);
  assert.doesNotMatch(routeSource, /id="statsCard"/);
  assert.doesNotMatch(routeSource, /ach-item/);
});
