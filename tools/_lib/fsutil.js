// 歇一会 - 文件工具：原子写入（.tmp + rename）+ 安全读取（损坏隔离）
// 写入防止崩溃/断电留下半截 JSON；读取时若发现损坏，把坏文件改名隔离而不是静默覆盖。

import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = filePath + ".tmp";
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tempPath, filePath);
}

/**
 * 安全读取 JSON 文件：
 * - 文件不存在或读不了 → 返回 undefined（调用方用默认值，不告警、不隔离）
 * - 内容解析失败 → 把坏文件改名隔离为 `原路径.corrupt-<时间戳>`（避免下一次保存把
 *   唯一的损坏证据覆盖掉），记录日志，返回 undefined
 */
export function readJsonSafe(filePath, { log = console.warn } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const quarantined = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, quarantined);
      log?.(`[歇一会] 数据文件损坏，已隔离: ${filePath} → ${quarantined}`);
    } catch {
      // 隔离失败（权限/占用等）也不阻塞：至少返回 undefined 走默认值
    }
    return undefined;
  }
}
