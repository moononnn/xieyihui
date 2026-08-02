// 歇一会 - 版本号比较（semver，兼容 2 段版本号与 v 前缀）
// 用于「检查更新」：对比本地 manifest 版本与 GitHub 最新 tag。

export function compareVersions(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(".").map(Number);
  const pb = String(b || "").replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** 去掉 tag 名开头的 v 前缀（GitHub tag 常用 vX.Y.Z） */
export function stripVersionPrefix(value) {
  return String(value || "").replace(/^v/i, "");
}
