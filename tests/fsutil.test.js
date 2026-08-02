import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../tools/_lib/fsutil.js";

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xieyihui-fsutil-"));
  return path.join(dir, name);
}

test("readJsonSafe：正常 JSON 原样返回", () => {
  const file = tmpFile("ok.json");
  fs.writeFileSync(file, JSON.stringify({ a: 1, b: [2, 3] }), "utf-8");
  assert.deepEqual(readJsonSafe(file), { a: 1, b: [2, 3] });
});

test("readJsonSafe：文件不存在返回 undefined，且不产生隔离文件", () => {
  const file = tmpFile("missing.json");
  const logs = [];
  assert.equal(readJsonSafe(file, { log: (m) => logs.push(m) }), undefined);
  assert.equal(logs.length, 0);
  assert.ok(!fs.existsSync(file + ".corrupt"), "不存在时不隔离");
});

test("readJsonSafe：损坏 JSON 返回 undefined 并把坏文件改名隔离", () => {
  const file = tmpFile("broken.json");
  fs.writeFileSync(file, "{ 这不是 JSON", "utf-8");
  const logs = [];
  const result = readJsonSafe(file, { log: (m) => logs.push(m) });
  assert.equal(result, undefined);
  assert.equal(logs.length, 1, "应记录一条损坏日志");
  assert.match(logs[0], /损坏/);
  assert.ok(!fs.existsSync(file), "坏文件已从原位移走");
  const quarantined = fs.readdirSync(path.dirname(file)).find((name) => name.startsWith("broken.json.corrupt-"));
  assert.ok(quarantined, "存在 .corrupt- 隔离文件");
  assert.match(fs.readFileSync(path.join(path.dirname(file), quarantined), "utf-8"), /这不是 JSON/);
});

test("writeJsonAtomic 写入后 readJsonSafe 能读回", () => {
  const file = tmpFile("roundtrip.json");
  writeJsonAtomic(file, { phase: "working", n: 7 });
  assert.deepEqual(readJsonSafe(file), { phase: "working", n: 7 });
  assert.ok(!fs.existsSync(file + ".tmp"), "不留 .tmp 残渣");
});
