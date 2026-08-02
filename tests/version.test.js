import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, stripVersionPrefix } from "../tools/_lib/version.js";

test("compareVersions：主版本优先", () => {
  assert.equal(compareVersions("3.0.0", "2.9.9"), 1);
  assert.equal(compareVersions("2.9.9", "3.0.0"), -1);
});

test("compareVersions：次版本与补丁版本", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.9.10", "0.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
});

test("compareVersions：相等返回 0（含 v 前缀混用）", () => {
  assert.equal(compareVersions("0.9.0", "0.9.0"), 0);
  assert.equal(compareVersions("v0.9.0", "0.9.0"), 0);
  assert.equal(compareVersions("v0.9.0", "v0.9.0"), 0);
});

test("compareVersions：兼容 2 段版本号", () => {
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.3", "1.2.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.1"), -1);
});

test("compareVersions：空值/非法值按 0 处理", () => {
  assert.equal(compareVersions("", "0.0.0"), 0);
  assert.equal(compareVersions("abc", "0.0.0"), 0);
  assert.equal(compareVersions("0.1.0", ""), 1);
});

test("stripVersionPrefix：去掉 tag 的 v 前缀", () => {
  assert.equal(stripVersionPrefix("v0.9.0"), "0.9.0");
  assert.equal(stripVersionPrefix("V1.2.3"), "1.2.3");
  assert.equal(stripVersionPrefix("0.8.1"), "0.8.1");
  assert.equal(stripVersionPrefix(""), "");
});
