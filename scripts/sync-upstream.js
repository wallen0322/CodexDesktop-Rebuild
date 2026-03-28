#!/usr/bin/env node
/**
 * sync-upstream.js — 从上游 Codex 官方构建中提取 ASAR 资源
 *
 * 流程:
 *   1. 检测最新版本 (appcast.xml + MS Store)
 *   2. 下载 macOS ZIP + Windows MSIX
 *   3. 解包并提取 app.asar
 *   4. 落盘到 src/{unix,win}/
 *
 * 用法:
 *   node scripts/sync-upstream.js                 # 仅有更新时同步
 *   node scripts/sync-upstream.js --force         # 强制重新同步
 *   node scripts/sync-upstream.js --check-only    # 仅检查版本不下载
 *   node scripts/sync-upstream.js --skip-mac      # 跳过 macOS
 *   node scripts/sync-upstream.js --skip-win      # 跳过 Windows
 */

const https = require("https");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

// ─── 证书注入 ────────────────────────────────────────────────────
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

// ─── 常量 ────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_UNIX = path.join(PROJECT_ROOT, "src", "unix");
const SRC_WIN = path.join(PROJECT_ROOT, "src", "win");
const TEMP_DIR = path.join(require("os").tmpdir(), "codex-sync");
const VERSION_FILE = path.join(__dirname, ".versions.json");

// ─── 参数解析 ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const CHECK_ONLY = args.includes("--check-only");
const SKIP_MAC = args.includes("--skip-mac");
const SKIP_WIN = args.includes("--skip-win");

// ─── HTTP 辅助 ───────────────────────────────────────────────────
function httpGet(url) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return httpGet(res.headers.location).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      })
      .on("error", reject);
  });
}

function downloadToFile(url, destPath, label = "") {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const doRequest = (reqUrl) => {
      const reqMod = reqUrl.startsWith("https") ? https : http;
      reqMod
        .get(reqUrl, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            return doRequest(res.headers.location);
          }
          const total = parseInt(res.headers["content-length"] || "0", 10);
          let downloaded = 0;
          res.on("data", (chunk) => {
            downloaded += chunk.length;
            file.write(chunk);
            if (total > 0 && process.stdout.isTTY) {
              const pct = ((downloaded / total) * 100).toFixed(1);
              const mb = (downloaded / 1024 / 1024).toFixed(1);
              const totalMb = (total / 1024 / 1024).toFixed(1);
              process.stdout.write(
                `\r  ⬇️  ${label} ${pct}% (${mb}/${totalMb} MB)`
              );
            }
          });
          res.on("end", () => {
            file.end();
            if (process.stdout.isTTY) process.stdout.write("\n");
            // 校验下载完整性
            if (total > 0 && downloaded < total) {
              fs.unlinkSync(destPath);
              reject(
                new Error(
                  `下载不完整: ${downloaded}/${total} 字节 (${label})`
                )
              );
            } else {
              resolve(destPath);
            }
          });
          res.on("error", reject);
        })
        .on("error", reject);
    };
    doRequest(url);
  });
}

// ─── 版本检测 ────────────────────────────────────────────────────
const { checkMacVersion, checkWindowsVersion } = require("./check-update");

function loadVersions() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveVersions(versions) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(versions, null, 2) + "\n");
}

// ─── macOS: ZIP 解包提取 ASAR ───────────────────────────────────
async function syncMac(macInfo) {
  const zipPath = path.join(TEMP_DIR, `Codex-mac-${macInfo.version}.zip`);
  const extractDir = path.join(TEMP_DIR, "mac-extract");

  // 下载
  if (!fs.existsSync(zipPath)) {
    console.log(`\n📥 下载 macOS ZIP: ${macInfo.version}`);
    await downloadToFile(macInfo.downloadUrl, zipPath, "macOS");
  } else {
    console.log(`\n📦 使用缓存: ${zipPath}`);
  }

  // 解压 ZIP（macOS Sparkle ZIP 可能非标准，用 ditto 或 7z）
  console.log("  📂 解压 ZIP...");
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });
  if (process.platform === "darwin") {
    // ditto 是 macOS 原生工具，能处理 Sparkle 非标准 ZIP
    execSync(`ditto -xk "${zipPath}" "${extractDir}" 2>/dev/null || true`);
  } else {
    // Linux/CI: 用 7z 做回退（比 unzip 兼容性更好）
    try {
      execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`);
    } catch {
      execSync(`7z x -y -o"${extractDir}" "${zipPath}" > /dev/null`);
    }
  }

  // 找到 .app/Contents/Resources/app.asar
  const appDir = findFile(extractDir, "app.asar");
  if (!appDir) {
    throw new Error("macOS ZIP 中未找到 app.asar");
  }
  console.log(`  📍 找到: ${path.relative(extractDir, appDir)}`);

  // 提取 ASAR
  const asarExtractDir = path.join(TEMP_DIR, "mac-asar");
  if (fs.existsSync(asarExtractDir)) {
    fs.rmSync(asarExtractDir, { recursive: true });
  }
  console.log("  📦 提取 ASAR...");
  execFileSync("asar", ["extract", appDir, asarExtractDir]);

  // 落盘到 src/upstream/unix/
  console.log(`  💾 同步到 ${path.relative(PROJECT_ROOT, SRC_UNIX)}/`);
  syncDirectory(asarExtractDir, SRC_UNIX);

  return asarExtractDir;
}

// ─── Windows: MSIX 解包提取 ASAR ────────────────────────────────
async function syncWin(winInfo) {
  const msixPath = path.join(
    TEMP_DIR,
    winInfo.packageName || `Codex-win-${winInfo.version}.msix`
  );
  const extractDir = path.join(TEMP_DIR, "win-extract");

  // 下载（MSIX 来自 MS CDN 的 HTTP 链接，用 curl 更可靠）
  if (!fs.existsSync(msixPath)) {
    console.log(`\n📥 下载 Windows MSIX: ${winInfo.version}`);
    execSync(
      `curl -L --retry 3 --retry-delay 2 -o "${msixPath}" "${winInfo.downloadUrl}"`,
      { stdio: "inherit" }
    );
  } else {
    console.log(`\n📦 使用缓存: ${msixPath}`);
  }

  // MSIX 是带 APPX 签名块的 ZIP，macOS 自带 unzip 不兼容，用 7zz
  console.log("  📂 解压 MSIX...");
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });
  // 优先 7zz (7-Zip 官方)，回退 7z (p7zip)，最后 unzip
  const sevenZipBin = findBinary(["7zz", "7z"]);
  if (sevenZipBin) {
    execSync(`"${sevenZipBin}" x -y -o"${extractDir}" "${msixPath}" > /dev/null 2>&1 || true`);
  } else {
    execSync(`unzip -q -o "${msixPath}" -d "${extractDir}"`);
  }

  // 在 MSIX 中找 app.asar
  // MSIX 结构: app/resources/app.asar 或直接 resources/app.asar
  const asarPath = findFile(extractDir, "app.asar");
  if (!asarPath) {
    // 列出内容帮助调试
    const files = execSync(`find "${extractDir}" -maxdepth 4 -type f`)
      .toString()
      .trim()
      .split("\n")
      .slice(0, 30);
    console.log("  ⚠️  MSIX 内容:");
    files.forEach((f) =>
      console.log(`    ${path.relative(extractDir, f)}`)
    );
    throw new Error("Windows MSIX 中未找到 app.asar");
  }
  console.log(`  📍 找到: ${path.relative(extractDir, asarPath)}`);

  // 提取 ASAR
  const asarExtractDir = path.join(TEMP_DIR, "win-asar");
  if (fs.existsSync(asarExtractDir)) {
    fs.rmSync(asarExtractDir, { recursive: true });
  }
  console.log("  📦 提取 ASAR...");
  execFileSync("asar", ["extract", asarPath, asarExtractDir]);

  // 落盘到 src/upstream/win/
  console.log(`  💾 同步到 ${path.relative(PROJECT_ROOT, SRC_WIN)}/`);
  syncDirectory(asarExtractDir, SRC_WIN);

  return asarExtractDir;
}

// ─── 目录同步（增量式） ──────────────────────────────────────────
function syncDirectory(srcDir, destDir) {
  // 清空目标后整体复制（保证一致性）
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  // Native modules are rebuilt at build time — skip them, keep pure-JS deps
  const NATIVE_MODULES = new Set(["better-sqlite3", "node-pty"]);

  const copyRecursive = (src, dest, depth = 0, parentName = "") => {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        // Inside node_modules: skip native modules only
        if (parentName === "node_modules" && NATIVE_MODULES.has(entry.name)) {
          continue;
        }
        fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath, depth + 1, entry.name);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };

  copyRecursive(srcDir, destDir);

  // 统计
  let fileCount = 0;
  const countFiles = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) countFiles(path.join(dir, e.name));
      else fileCount++;
    }
  };
  countFiles(destDir);
  console.log(`    📊 ${fileCount} 个文件`);
}

// ─── 辅助 ────────────────────────────────────────────────────────
function findBinary(candidates) {
  for (const bin of candidates) {
    try {
      execSync(`which "${bin}" 2>/dev/null`, { stdio: "pipe" });
      return bin;
    } catch {}
  }
  return null;
}

function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ─── 主流程 ──────────────────────────────────────────────────────
async function main() {
  console.log("🔄 Codex 上游资源同步\n");

  // 确保临时目录
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  // 1. 检测版本
  console.log("📡 检测最新版本...");
  const [macResult, winResult] = await Promise.allSettled([
    SKIP_MAC ? Promise.reject(new Error("skipped")) : checkMacVersion(),
    SKIP_WIN ? Promise.reject(new Error("skipped")) : checkWindowsVersion(),
  ]);

  const macInfo =
    macResult.status === "fulfilled" ? macResult.value : null;
  const winInfo =
    winResult.status === "fulfilled" ? winResult.value : null;

  if (macInfo) {
    console.log(
      `  macOS:   ${macInfo.version} (build ${macInfo.build})`
    );
  } else if (!SKIP_MAC) {
    console.error(`  ⚠️  macOS 检测失败: ${macResult.reason.message}`);
  }

  if (winInfo) {
    console.log(`  Windows: ${winInfo.version}`);
  } else if (!SKIP_WIN) {
    console.error(`  ⚠️  Windows 检测失败: ${winResult.reason.message}`);
  }

  // 2. 检查是否需要更新
  const saved = loadVersions();
  const needMac =
    macInfo &&
    (FORCE ||
      !saved.macOS ||
      saved.macOS.version !== macInfo.version ||
      saved.macOS.build !== macInfo.build);
  const needWin =
    winInfo &&
    (FORCE || !saved.Windows || saved.Windows.version !== winInfo.version);

  if (!needMac && !needWin) {
    console.log("\n✅ 所有平台均为最新，无需同步。");
    if (!FORCE) return;
  }

  if (CHECK_ONLY) {
    if (needMac) console.log(`\n🆕 macOS 需要更新: ${macInfo.version}`);
    if (needWin) console.log(`\n🆕 Windows 需要更新: ${winInfo.version}`);
    return;
  }

  // 3. 下载并解包
  if (needMac) {
    await syncMac(macInfo);
  }

  if (needWin) {
    await syncWin(winInfo);
  }

  // 4. 保存版本记录
  const newSaved = { ...saved };
  if (needMac && macInfo) {
    newSaved.macOS = {
      version: macInfo.version,
      build: macInfo.build,
      checkedAt: new Date().toISOString(),
    };
  }
  if (needWin && winInfo) {
    newSaved.Windows = {
      version: winInfo.version,
      checkedAt: new Date().toISOString(),
    };
  }
  saveVersions(newSaved);

  console.log(`\n✅ 同步完成`);
  console.log(`   Unix 资源: src/unix/`);
  console.log(`   Win  资源: src/win/`);
  console.log(`\n💡 下一步: 运行 patch 脚本处理 upstream 资源，然后构建`);
}

main().catch((e) => {
  console.error(`\n❌ 错误: ${e.message}`);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
