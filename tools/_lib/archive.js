// 歇一会 - 台词档案：把模型生成过的台词存下来，作为第二层兜底
// 预生成失败时先从档案抽（按助手+类型，轮转不重复），档案空了才用写死词库。
// 档案是“活的”：每次成功预生成都会追加进去，用得越久越不像初始话术。

import fs from "node:fs";
import path from "node:path";
import { EFFECT_TYPES } from "./replies.js";
import { readJsonSafe, writeJsonAtomic } from "./fsutil.js";

const DEFAULT_ARCHIVE_MAX_PER_TYPE = 40;
const ARCHIVE_FILE = "archive.json";

function archivePath(dataDir, pluginId) {
  return path.join(dataDir, pluginId, ARCHIVE_FILE);
}

export function loadArchive(dataDir, pluginId) {
  const parsed = readJsonSafe(archivePath(dataDir, pluginId));
  if (parsed === undefined) return {};
  return normalizeArchive(parsed);
}

export function saveArchive(dataDir, pluginId, archive) {
  writeJsonAtomic(archivePath(dataDir, pluginId), archive);
}

function normalizeArchive(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const agentId of Object.keys(value)) {
    const types = value[agentId];
    if (!types || typeof types !== "object") continue;
    result[agentId] = {};
    for (const effect of EFFECT_TYPES) {
      const items = Array.isArray(types[effect]) ? types[effect].filter((t) => typeof t === "string" && t.trim()) : [];
      result[agentId][effect] = items.slice(0, DEFAULT_ARCHIVE_MAX_PER_TYPE);
    }
  }
  return result;
}

/**
 * 追加台词到档案：按 助手+类型 去重、限容（超出丢最旧的）。
 * 返回更新后的 archive（原对象也会被修改）。
 */
export function appendToArchive(archive, agentId, effect, texts, maxPerType = DEFAULT_ARCHIVE_MAX_PER_TYPE) {
  if (!agentId || !EFFECT_TYPES.includes(effect)) return archive;
  const items = (Array.isArray(texts) ? texts : []).filter((t) => typeof t === "string" && t.trim());
  if (!items.length) return archive;

  if (!archive[agentId]) archive[agentId] = {};
  const bucket = archive[agentId][effect] || [];
  const seen = new Set(bucket);
  for (const text of items) {
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    bucket.push(trimmed);
    seen.add(trimmed);
  }
  archive[agentId][effect] = bucket.length > maxPerType ? bucket.slice(bucket.length - maxPerType) : bucket;
  return archive;
}

// 本轮已抽过的档案台词（agentId|effect|text），休息窗口开始时重置
const archiveUsed = new Set();

/**
 * 从档案抽一条本轮没用过的（按 助手+类型）。
 * 本轮用过的不会重复出现；全部用完返回 null，调用方继续降级到写死词库。
 */
export function pickFromArchive(archive, agentId, effect = "reply") {
  const bucket = archive?.[agentId]?.[effect];
  if (!Array.isArray(bucket) || !bucket.length) return null;
  for (const text of bucket) {
    const key = `${agentId}|${effect}|${text}`;
    if (!archiveUsed.has(key)) {
      archiveUsed.add(key);
      return text;
    }
  }
  return null;
}

/** 测试/新休息窗口用：清空“本轮已抽”标记 */
export function resetArchivePickers() {
  archiveUsed.clear();
}
