// 歇一会 - 文案模型配置
// 复用 Hana 的模型目录，但配置本身归插件所有，支持 Hana 模型与自定义 OpenAI 兼容 API。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeJsonAtomic } from "./fsutil.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const MODELS_JSON = path.join(HANA_HOME, "models.json");
const DEFAULT_MODEL_CONFIG = Object.freeze({
  source: "agent",
  providerId: "",
  modelId: "",
  customBaseUrl: "",
  customApiKey: "",
  customModel: "",
});

const SOURCES = new Set(["agent", "hana", "custom"]);

export function getModelConfigPath(dataDir, pluginId) {
  return path.join(dataDir, pluginId, "model-config.json");
}

export function normalizeModelConfig(input = {}) {
  const source = SOURCES.has(input.source) ? input.source : DEFAULT_MODEL_CONFIG.source;
  return {
    source,
    providerId: cleanText(input.providerId, 160),
    modelId: cleanText(input.modelId, 240),
    customBaseUrl: cleanText(input.customBaseUrl, 1000),
    customApiKey: cleanText(input.customApiKey, 2000),
    customModel: cleanText(input.customModel, 240),
  };
}

export function mergeModelConfig(current, patch = {}) {
  const previous = normalizeModelConfig(current);
  const merged = normalizeModelConfig({ ...previous, ...patch });
  const masked = patch.customApiKey === "********";
  const omitted = patch.customApiKey === undefined;
  if (masked || omitted || patch.customApiKey === "") {
    merged.customApiKey = previous.customApiKey;
  }
  if (patch.clearCustomApiKey === true) merged.customApiKey = "";
  delete merged.clearCustomApiKey;
  return merged;
}

export function readModelConfig(dataDir, pluginId) {
  try {
    const raw = JSON.parse(fs.readFileSync(getModelConfigPath(dataDir, pluginId), "utf-8"));
    return normalizeModelConfig(raw);
  } catch {
    return { ...DEFAULT_MODEL_CONFIG };
  }
}

export function writeModelConfig(dataDir, pluginId, patch) {
  const current = readModelConfig(dataDir, pluginId);
  const next = mergeModelConfig(current, patch);
  writeJsonAtomic(getModelConfigPath(dataDir, pluginId), next);
  return next;
}

export function sanitizeModelConfig(config) {
  const safe = normalizeModelConfig(config);
  safe.customApiKey = safe.customApiKey ? "********" : "";
  return safe;
}

export function validateModelConfig(config) {
  const normalized = normalizeModelConfig(config);
  if (normalized.source === "hana" && (!normalized.providerId || !normalized.modelId)) {
    return "请选择 Hana 的供应商和模型";
  }
  if (normalized.source === "custom") {
    if (!normalized.customBaseUrl || !normalized.customApiKey || !normalized.customModel) {
      return "请填写完整的自定义配置（API 地址 / Key / 模型名）";
    }
    try {
      const url = new URL(normalized.customBaseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("协议不支持");
    } catch {
      return "自定义 API 地址必须是 http:// 或 https:// 地址";
    }
  }
  return "";
}

export function getAvailableTextModels() {
  const result = [];
  try {
    const catalog = JSON.parse(fs.readFileSync(MODELS_JSON, "utf-8"));
    for (const [providerId, provider] of Object.entries(catalog.providers || {})) {
      const models = (provider.models || [])
        .map((model) => typeof model === "string" ? { id: model, name: model, input: ["text"] } : model)
        .filter((model) => Array.isArray(model.input) && model.input.includes("text"))
        .map((model) => ({ id: cleanText(model.id, 240), name: cleanText(model.name || model.id, 240) }))
        .filter((model) => model.id);
      if (!models.length) continue;
      result.push({
        providerId,
        providerName: provider.name || providerId,
        models,
      });
    }
  } catch {}
  return result;
}

export function extractModelText(result) {
  if (typeof result === "string") return result;
  const value = result?.text ?? result?.content ?? result?.output ?? "";
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || "";
    }).join("");
  }
  return String(value || "");
}

export async function callCustomModel(config, input, timeoutMs = 20000) {
  const baseUrl = config.customBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.customApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.customModel,
      messages: input.messages,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`自定义模型返回 HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

export async function sampleConfiguredModel(ctx, config, input, timeoutMs = 20000) {
  if (config.source === "custom") {
    return callCustomModel(config, input, timeoutMs);
  }
  if (config.source === "hana" && config.providerId && config.modelId) {
    return ctx.bus.request("utility:call-text", {
      ...input,
      providerId: config.providerId,
      modelId: config.modelId,
    }, { timeoutMs });
  }
  // agent：交给 Hana 按 agentId/sessionPath 解析该助手当前配置的 utility 模型
  if (ctx.bus?.request) {
    return ctx.bus.request("utility:call-text", input, { timeoutMs });
  }
  if (ctx.model?.sample) return ctx.model.sample(input);
  return ctx.bus.request("utility:call-text", input, { timeoutMs });
}

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}
