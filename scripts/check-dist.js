/**
 * dist 与 src 一致性校验
 *
 * 把源码重新构建到临时目录，再与当前 dist 逐文件比对内容哈希。
 * 出现差异说明 dist 落后于 src（改了源码忘记构建），以非 0 退出；
 * 该脚本挂在 prepublishOnly 上，保证不会把过期产物发布出去。
 *
 * 用法：pnpm run check:dist
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(root, "dist");

/**
 * sourcemap 里的 sources 是相对输出目录的路径，换目录构建必然不同，
 * 因此只比对真正的产物文件。
 */
const IGNORED = [/\.map$/];

function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, base));
    } else if (!IGNORED.some(pattern => pattern.test(entry.name))) {
      files.push(relative(base, full));
    }
  }
  return files.sort();
}

/** 生成「相对路径 -> 内容哈希」快照 */
function snapshot(dir) {
  const result = new Map();
  for (const file of listFiles(dir)) {
    const hash = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
    result.set(file, hash);
  }
  return result;
}

function compare(expected, actual) {
  const problems = [];
  for (const [file, hash] of expected) {
    if (!actual.has(file)) {
      problems.push(`缺少 ${file}`);
    } else if (actual.get(file) !== hash) {
      problems.push(`内容过期 ${file}`);
    }
  }
  for (const file of actual.keys()) {
    if (!expected.has(file)) problems.push(`多余 ${file}`);
  }
  return problems;
}

if (!existsSync(distDir)) {
  console.error("check-dist 失败：dist 不存在，请先运行 pnpm build");
  process.exit(1);
}

// 临时目录放在项目根下（与 dist 同级），让 Rollup/TS 输出的相对路径与真实构建保持一致
const tempDir = mkdtempSync(join(root, ".dist-check-"));
let failure = null;
let checked = 0;

try {
  execSync("pnpm exec rollup -c rollup.config.js", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DIST_DIR: basename(tempDir) },
  });

  const expected = snapshot(tempDir);
  const problems = compare(expected, snapshot(distDir));
  checked = expected.size;

  if (problems.length > 0) {
    failure = `dist 与 src 不同步，请运行 pnpm build 后重新校验\n  ${problems.join("\n  ")}`;
  }
} catch (error) {
  failure = `重新构建失败，请先排查构建报错\n${error.message}`;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failure) {
  console.error(`check-dist 失败：${failure}`);
  process.exit(1);
}

console.log(`check-dist 通过：${checked} 个产物与 src 一致`);
