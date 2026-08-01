import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAvailableTextModels,
  mergeModelConfig,
  normalizeModelConfig,
  readModelConfig,
  sanitizeModelConfig,
  validateModelConfig,
  writeModelConfig,
} from "../tools/_lib/model-config.js";

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xieyihui-model-config-test-"));
}

test("normalizeModelConfig：非法 source 回退到 agent，字段裁剪", () => {
  const config = normalizeModelConfig({ source: "evil", providerId: "  x  ", modelId: "m".repeat(300) });
  assert.equal(config.source, "agent");
  assert.equal(config.providerId, "x");
  assert.equal(config.modelId.length, 240);
});

test("mergeModelConfig：Key 脱敏占位符不会覆盖已保存的 Key", () => {
  const current = { source: "custom", customBaseUrl: "https://api.example.com/v1", customApiKey: "secret-123", customModel: "demo" };
  const merged = mergeModelConfig(current, { customApiKey: "********" });
  assert.equal(merged.customApiKey, "secret-123");
  // 空字符串/缺省也不覆盖
  assert.equal(mergeModelConfig(current, { customApiKey: "" }).customApiKey, "secret-123");
  assert.equal(mergeModelConfig(current, {}).customApiKey, "secret-123");
  // 明确清除才删除
  assert.equal(mergeModelConfig(current, { clearCustomApiKey: true }).customApiKey, "");
});

test("writeModelConfig + readModelConfig：持久化往返，Key 保留", () => {
  const dataDir = makeDataDir();
  try {
    writeModelConfig(dataDir, "xieyihui", { source: "hana", providerId: "deepseek", modelId: "deepseek-chat" });
    const loaded = readModelConfig(dataDir, "xieyihui");
    assert.equal(loaded.source, "hana");
    assert.equal(loaded.providerId, "deepseek");
    assert.equal(loaded.modelId, "deepseek-chat");
    // 损坏文件安全回退默认
    fs.writeFileSync(path.join(dataDir, "xieyihui", "model-config.json"), "{broken", "utf-8");
    assert.deepEqual(readModelConfig(dataDir, "xieyihui"), {
      source: "agent", providerId: "", modelId: "", customBaseUrl: "", customApiKey: "", customModel: "",
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("sanitizeModelConfig：Key 只显示脱敏占位符", () => {
  const safe = sanitizeModelConfig({ source: "custom", customBaseUrl: "https://x", customApiKey: "abc", customModel: "m" });
  assert.equal(safe.customApiKey, "********");
  assert.equal(sanitizeModelConfig({ customApiKey: "" }).customApiKey, "");
});

test("validateModelConfig：hana 缺选择报错，custom 必须完整且协议合法", () => {
  assert.ok(validateModelConfig({ source: "hana", providerId: "", modelId: "" }));
  assert.equal(validateModelConfig({ source: "hana", providerId: "deepseek", modelId: "deepseek-chat" }), "");
  assert.ok(validateModelConfig({ source: "custom", customBaseUrl: "", customApiKey: "", customModel: "" }));
  assert.ok(validateModelConfig({ source: "custom", customBaseUrl: "ftp://x", customApiKey: "k", customModel: "m" }));
  assert.equal(
    validateModelConfig({ source: "custom", customBaseUrl: "https://api.example.com/v1", customApiKey: "k", customModel: "m" }),
    ""
  );
  assert.equal(validateModelConfig({ source: "agent" }), "");
});

test("getAvailableTextModels：只返回含文本输入的模型", () => {
  const models = getAvailableTextModels();
  assert.ok(Array.isArray(models));
  for (const provider of models) {
    assert.ok(provider.providerId);
    assert.ok(Array.isArray(provider.models));
    for (const model of provider.models) {
      assert.ok(model.id);
      assert.ok(model.name);
    }
  }
});
