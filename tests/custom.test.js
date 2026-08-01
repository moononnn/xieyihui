import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import registerRoutes, { parseCustomDuration, formatOptionValue } from "../routes/rest.js";
import { stop as stopTimer } from "../tools/_lib/timer.js";
import { DEFAULT_CONFIG, state } from "../tools/_lib/state.js";

function buildApp() {
  const gets = new Map();
  const posts = new Map();
  const app = {
    get(route, handler) { gets.set(route, handler); },
    post(route, handler) { posts.set(route, handler); },
  };
  return { app, gets, posts };
}

function register() {
  const dataDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-custom-test-"));
  const { app, gets, posts } = buildApp();
  registerRoutes(app, {
    pluginId: "xieyihui",
    pluginDir: process.cwd(),
    dataDir,
    bus: { request: async () => ({}) },
    log: {},
  });
  return { dataDir, gets, posts };
}

function renderPage(gets) {
  return gets.get("/page")({ html: (value) => value });
}

test("parseCustomDuration：分钟存储直接取整", () => {
  assert.equal(parseCustomDuration("50", "分钟"), 50);
  assert.equal(parseCustomDuration(" 45 ", "分钟"), 45);
  assert.equal(parseCustomDuration("25.5", "分钟"), 26);
  assert.equal(parseCustomDuration("1.4", "分钟"), 1);
  assert.equal(parseCustomDuration("1.5", "分钟"), 2);
  assert.equal(parseCustomDuration("50分钟", "分钟"), null);
  assert.equal(parseCustomDuration("0", "分钟"), null);
  assert.equal(parseCustomDuration("-5", "分钟"), null);
  assert.equal(parseCustomDuration("abc", "分钟"), null);
  assert.equal(parseCustomDuration("", "分钟"), null);
  assert.equal(parseCustomDuration("1.5.2", "分钟"), null);
  assert.equal(parseCustomDuration("1.", "分钟"), null);
  assert.equal(parseCustomDuration("50 ", "分钟"), 50);
});

test("parseCustomDuration：秒存储按分钟×60 换算", () => {
  assert.equal(parseCustomDuration("2", "秒"), 120);
  assert.equal(parseCustomDuration("1.5", "秒"), 90);
  assert.equal(parseCustomDuration("0.5", "秒"), 30);
  assert.equal(parseCustomDuration("0.33", "秒"), 20);
  assert.equal(parseCustomDuration("5", "秒"), 300);
  assert.equal(parseCustomDuration("0", "秒"), null);
  assert.equal(parseCustomDuration("2分钟", "秒"), null);
  assert.equal(parseCustomDuration("90秒", "秒"), null);
  assert.equal(parseCustomDuration("1小时", "秒"), null);
  assert.equal(parseCustomDuration("-2", "秒"), null);
  assert.equal(parseCustomDuration("", "秒"), null);
});

test("formatOptionValue：分钟原样，秒整分转分钟", () => {
  assert.equal(formatOptionValue(50, "分钟"), "50 分钟");
  assert.equal(formatOptionValue(1, "分钟"), "1 分钟");
  assert.equal(formatOptionValue(20, "秒"), "20 秒");
  assert.equal(formatOptionValue(45, "秒"), "45 秒");
  assert.equal(formatOptionValue(90, "秒"), "90 秒");
  assert.equal(formatOptionValue(60, "秒"), "1 分钟");
  assert.equal(formatOptionValue(120, "秒"), "2 分钟");
  assert.equal(formatOptionValue(300, "秒"), "5 分钟");
  assert.equal(formatOptionValue(0, "秒"), "0 秒");
});

test("渲染：预设值为 3 项 + 自定义按钮，无旧的第 4 项", () => {
  const { dataDir, gets } = register();
  try {
    state.config = { ...DEFAULT_CONFIG, workInterval: 20, breakDuration: 60 };
    const html = renderPage(gets);
    assert.match(html, /data-key="workInterval" data-value="10"/);
    assert.match(html, /data-key="workInterval" data-value="20"/);
    assert.match(html, /data-key="workInterval" data-value="30"/);
    assert.doesNotMatch(html, /data-key="workInterval" data-value="45"/);
    assert.match(html, /data-key="breakDuration" data-value="20"/);
    assert.match(html, /data-key="breakDuration" data-value="30"/);
    assert.match(html, /data-key="breakDuration" data-value="60"/);
    assert.doesNotMatch(html, /data-key="breakDuration" data-value="180"/);
    assert.doesNotMatch(html, /data-key="breakDuration" data-value="300"/);
    // 当前值在预设内：自定义按钮显示"自定义"且未选中
    assert.match(html, /data-key="workInterval" data-custom="1"[^>]*>自定义<\/button>/);
    assert.match(html, /data-key="breakDuration" data-custom="1"[^>]*>自定义<\/button>/);
    assert.match(html, /class="option"[^>]*data-key="workInterval" data-custom="1"/);
    assert.doesNotMatch(html, /class="option selected"[^>]*data-key="workInterval" data-custom="1"/);
  } finally {
    stopTimer();
    state.config = { ...DEFAULT_CONFIG };
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("渲染：当前值为非预设时，自定义按钮选中并显示该值", () => {
  const { dataDir, gets } = register();
  try {
    state.config = { ...DEFAULT_CONFIG, workInterval: 50, breakDuration: 300 };
    const html = renderPage(gets);
    assert.match(html, /class="option selected"[^>]*data-key="workInterval" data-custom="1"[^>]*>50 分钟<\/button>/);
    assert.match(html, /class="option selected"[^>]*data-key="breakDuration" data-custom="1"[^>]*>5 分钟<\/button>/);
    // 旧值 45（原第 4 项）也走自定义通道显示
    state.config = { ...DEFAULT_CONFIG, workInterval: 45 };
    const html2 = renderPage(gets);
    assert.match(html2, /class="option selected"[^>]*data-key="workInterval" data-custom="1"[^>]*>45 分钟<\/button>/);
    // 旧值 300（原 5 分钟）同理
    state.config = { ...DEFAULT_CONFIG, breakDuration: 300 };
    const html3 = renderPage(gets);
    assert.match(html3, /class="option selected"[^>]*data-key="breakDuration" data-custom="1"[^>]*>5 分钟<\/button>/);
  } finally {
    stopTimer();
    state.config = { ...DEFAULT_CONFIG };
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("update-config：超过合理上限被拒绝，上限内放行", async () => {
  const { dataDir, posts } = register();
  try {
    const handler = posts.get("/api/update-config");
    assert.ok(handler, "update-config 路由应注册");

    const mockC = (body) => ({
      req: { json: async () => body },
      json: (payload, status) => ({ payload, status }),
    });

    const tooBig = await handler(mockC({ workInterval: 999 }));
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.payload.error, /不能超过/);

    const tooLong = await handler(mockC({ breakDuration: 99999 }));
    assert.equal(tooLong.status, 400);

    const ok1 = await handler(mockC({ workInterval: 480 }));
    assert.equal(ok1.status, undefined);
    assert.equal(ok1.payload.ok, true);
    assert.equal(ok1.payload.config.workInterval, 480);

    const ok2 = await handler(mockC({ breakDuration: 7200 }));
    assert.equal(ok2.payload.ok, true);
    assert.equal(ok2.payload.config.breakDuration, 7200);
  } finally {
    stopTimer();
    state.config = { ...DEFAULT_CONFIG };
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("渲染后的页面脚本注入自定义所需的配置与函数", () => {
  const { dataDir, gets } = register();
  try {
    state.config = { ...DEFAULT_CONFIG, workInterval: 20, breakDuration: 60 };
    const html = renderPage(gets);
    assert.match(html, /var OPTIONS = \{"workInterval":\{"presets":\[10,20,30\]/);
    assert.match(html, /var LIMITS = \{"workInterval":480,"breakDuration":7200,"awayThresholdMinutes":120\}/);
    assert.match(html, /var CURRENT_CONFIG = \{"workInterval":20,"breakDuration":60/);
    assert.match(html, /var parseCustomDuration = function parseCustomDuration\(text, unit\)/);
    assert.match(html, /var formatOptionValue = function formatOptionValue\(value, unit\)/);
    // 内联函数体不允许残留模板占位符（会被服务端模板吞掉）
    assert.doesNotMatch(html, /function parseCustomDuration[\s\S]{0,500}\$\{/);
    // 页面整体脚本语法有效
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    for (const script of scripts) new Function(script);
  } finally {
    stopTimer();
    state.config = { ...DEFAULT_CONFIG };
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
