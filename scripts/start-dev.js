#!/usr/bin/env node
/**
 * Smart development startup script
 * Automatically detects system architecture and sets correct CLI path
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Detect platform and architecture
const platform = process.platform;
const arch = os.arch();

// Map to CLI binary paths
const platformMap = {
  darwin: {
    x64: 'darwin-x64',
    arm64: 'darwin-arm64',
  },
  linux: {
    x64: 'linux-x64',
    arm64: 'linux-arm64',
  },
  win32: {
    x64: 'win32-x64',
  },
};

const binDir = platformMap[platform]?.[arch];
if (!binDir) {
  console.error(`Unsupported platform/arch: ${platform}/${arch}`);
  process.exit(1);
}

const cliName = platform === 'win32' ? 'codex.exe' : 'codex';
const localCliPath = path.join(__dirname, '..', 'resources', 'bin', binDir, cliName);

// 平台 -> target triple 映射（与 forge.config.js 保持一致）
const TARGET_TRIPLE_MAP = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

function getVendorRoots() {
  return [
    path.join(__dirname, '..', 'node_modules', '@openai', `codex-${binDir}`),
    path.join(__dirname, '..', 'node_modules', '@openai', 'codex'),
    path.join(__dirname, '..', 'node_modules', '@cometix', 'codex'),
  ];
}

function getVendorBinaryPath() {
  for (const root of getVendorRoots()) {
    const vendorPath = path.join(root, 'vendor', triple, 'codex', cliName);
    if (fs.existsSync(vendorPath)) return vendorPath;
  }

  return null;
}

// 从 npm vendor 同步到 resources/bin/
const triple = TARGET_TRIPLE_MAP[binDir];
if (triple) {
  const vendorPath = getVendorBinaryPath();
  if (vendorPath && fs.existsSync(vendorPath)) {
    const localDir = path.join(__dirname, '..', 'resources', 'bin', binDir);
    fs.mkdirSync(localDir, { recursive: true });
    fs.copyFileSync(vendorPath, path.join(localDir, cliName));
    try { fs.chmodSync(path.join(localDir, cliName), 0o755); } catch {}
    console.log(`[start-dev] Synced codex binary: vendor → resources/bin/${binDir}/${cliName}`);
  }
}

const cliPath = localCliPath;

// Verify CLI exists
if (!fs.existsSync(cliPath)) {
  console.error(`CLI not found at: ${cliPath}`);
  console.error('Tried: resources/bin/, node_modules/@openai/codex-*/vendor/, and node_modules/@cometix/codex/vendor/');
  process.exit(1);
}

console.log(`[start-dev] Platform: ${platform}, Arch: ${arch}`);
console.log(`[start-dev] CLI Path: ${cliPath}`);

// Launch Electron with CLI path
const electronBin = require('electron');
const child = spawn(electronBin, ['.'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEX_CLI_PATH: cliPath,
    BUILD_FLAVOR: process.env.BUILD_FLAVOR || 'dev',
    // 使用 app:// 自定义协议加载静态资源（而非 Vite dev server）
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'app://-/index.html',
  },
});

child.on('close', (code) => {
  process.exit(code);
});
