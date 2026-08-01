import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendToArchive,
  loadArchive,
  pickFromArchive,
  resetArchivePickers,
  saveArchive,
} from "../tools/_lib/archive.js";

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xieyihui-archive-test-"));
}

test("档案追加台词：去重并限容 40 条，超出的丢最旧", () => {
  const archive = {};
  appendToArchive(archive, "agent-a", "reply", ["第一句。", "第二句。", "第一句。"]);
  assert.equal(archive["agent-a"].reply.length, 2);

  const many = Array.from({ length: 50 }, (_, i) => `台词第 ${i + 1} 句。`);
  appendToArchive(archive, "agent-a", "reply", many);
  assert.equal(archive["agent-a"].reply.length, 40);
  assert.ok(!archive["agent-a"].reply.includes("第一句。"), "最旧的台词应该被挤出");
  assert.ok(archive["agent-a"].reply.includes("台词第 50 句。"), "最新的台词应该保留");
});

test("档案按助手+类型分开存，未知类型忽略", () => {
  const archive = {};
  appendToArchive(archive, "agent-a", "move", ["躲一句。"]);
  appendToArchive(archive, "agent-b", "reply", ["另一位助手的劝阻。"]);
  appendToArchive(archive, "agent-a", "unknown", ["不该被存进去。"]);
  assert.equal(archive["agent-a"].move.length, 1);
  assert.equal(archive["agent-b"].reply.length, 1);
  assert.equal(archive["agent-a"].unknown, undefined);
});

test("从档案抽取本轮不重复，用完返回 null，reset 后可再抽", () => {
  resetArchivePickers();
  const archive = { "agent-a": { extend: ["加时一。", "加时二。", "加时三。"] } };
  const seen = new Set();
  for (let i = 0; i < 3; i += 1) {
    const text = pickFromArchive(archive, "agent-a", "extend");
    assert.ok(text, "应能抽到档案台词");
    assert.ok(!seen.has(text), "本轮内不应重复");
    seen.add(text);
  }
  assert.equal(pickFromArchive(archive, "agent-a", "extend"), null);
  resetArchivePickers();
  assert.ok(pickFromArchive(archive, "agent-a", "extend"), "reset 后可以重新抽");
  assert.equal(pickFromArchive(archive, "agent-a", "stall"), null);
  assert.equal(pickFromArchive(archive, "unknown", "reply"), null);
});

test("档案持久化：保存后能重新读回并抽取", () => {
  resetArchivePickers();
  const dataDir = makeDataDir();
  try {
    const archive = {};
    appendToArchive(archive, "agent-a", "reply", ["持久化测试台词。"]);
    saveArchive(dataDir, "xieyihui", archive);
    const loaded = loadArchive(dataDir, "xieyihui");
    assert.equal(loaded["agent-a"].reply.length, 1);
    assert.equal(pickFromArchive(loaded, "agent-a", "reply"), "持久化测试台词。");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("档案文件损坏时安全回退为空档案", () => {
  const dataDir = makeDataDir();
  try {
    const dir = path.join(dataDir, "xieyihui");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "archive.json"), "not-json{{", "utf-8");
    assert.deepEqual(loadArchive(dataDir, "xieyihui"), {});
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
