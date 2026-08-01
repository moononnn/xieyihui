// 歇一会 - 文件工具：原子写入（.tmp + rename），防止崩溃/断电留下半截 JSON

import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = filePath + ".tmp";
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tempPath, filePath);
}
