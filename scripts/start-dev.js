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

// Priority: upstream CLI from src/ > @openai/codex vendor > @cometix/codex vendor > resources/bin/
const srcPlatform = platform === 'darwin'
  ? (arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
  : platform === 'win32' ? 'win' : `${platform}-${arch}`;

const tripleMap = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

const cometixPackageMap = {
  'darwin-arm64': 'codex-darwin-arm64',
  'darwin-x64': 'codex-darwin-x64',
  'linux-arm64': 'codex-linux-arm64',
  'linux-x64': 'codex-linux-x64',
  'win32-x64': 'codex-win32-x64',
};

const triple = tripleMap[binDir];

function existingPath(...parts) {
  const candidate = path.join(...parts);
  return fs.existsSync(candidate) ? candidate : null;
}

const candidates = [
  // 1. Upstream CLI (from sync-upstream, matches app version)
  path.join(__dirname, '..', 'src', srcPlatform, cliName),
  // 2. Official @openai/codex package, if installed locally
  triple && existingPath(__dirname, '..', 'node_modules', '@openai', `codex-${binDir}`, 'vendor', triple, 'codex', cliName),
  triple && existingPath(__dirname, '..', 'node_modules', '@openai', 'codex', 'vendor', triple, 'codex', cliName),
  // 3. @cometix/codex platform package (0.128+ uses separate packages)
  (() => {
    const pkg = cometixPackageMap[binDir];
    if (!pkg || !triple) return null;
    // New structure: @cometix/codex-{platform}/vendor/{triple}/codex/codex
    const newPath = existingPath(__dirname, '..', 'node_modules', '@cometix', pkg, 'vendor', triple, 'codex', cliName);
    if (newPath) return newPath;
    // Old structure: @cometix/codex/vendor/{triple}/codex/codex
    return existingPath(__dirname, '..', 'node_modules', '@cometix', 'codex', 'vendor', triple, 'codex', cliName);
  })(),
  // 4. Local resources/bin/
  path.join(__dirname, '..', 'resources', 'bin', binDir, cliName),
].filter(Boolean);

const cliPath = candidates.find(p => fs.existsSync(p));

// Verify CLI exists
if (!cliPath) {
  console.error('CLI not found. Tried:');
  for (const candidate of candidates) console.error(`  - ${candidate}`);
  process.exit(1);
}

// Resolve app entry: prefer platform-specific _asar/ (has its own package.json)
const appRoot = path.join(__dirname, '..', 'src', srcPlatform, '_asar');
const appEntry = fs.existsSync(appRoot) ? appRoot : path.join(__dirname, '..');

console.log(`[start-dev] Platform: ${platform}, Arch: ${arch}`);
console.log(`[start-dev] CLI Path: ${cliPath}`);
console.log(`[start-dev] App Root: ${appEntry}`);

// Launch Electron with CLI path
const electronBin = require('electron');
const child = spawn(electronBin, [appEntry], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEX_CLI_PATH: cliPath,
    BUILD_FLAVOR: process.env.BUILD_FLAVOR || 'dev',
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'app://-/index.html',
  },
});

child.on('close', (code) => {
  process.exit(code);
});
