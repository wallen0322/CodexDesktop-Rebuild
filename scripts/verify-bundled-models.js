#!/usr/bin/env node
/**
 * Verify that a bundled Codex binary exposes the expected models through app-server.
 *
 * Usage examples:
 *   node scripts/verify-bundled-models.js --binary out/Codex-win32-x64/resources/codex.exe --require gpt-5.5
 *   node scripts/verify-bundled-models.js --json --require gpt-5.5 --require gpt-5.4
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REQUEST_TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const args = {
    binary: null,
    require: [],
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--binary") {
      args.binary = argv[++i] || null;
    } else if (arg === "--require") {
      const model = argv[++i];
      if (model) args.require.push(model);
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function platformArchDir() {
  const platform = process.platform;
  const arch = os.arch();

  if (platform === "win32" && arch === "x64") return "win32-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";

  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
}

function defaultBinaryPath() {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const platformDir = platformArchDir();
  const outDir = path.join(__dirname, "..", "out");

  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(
      path.join(outDir, "win", "Codex-win32-x64", "resources", binaryName),
    );
  } else if (process.platform === "darwin") {
    const macDir = os.arch() === "arm64" ? "mac-arm64" : "mac-x64";
    candidates.push(
      path.join(outDir, macDir, "Codex.app", "Contents", "Resources", binaryName),
    );
  }

  candidates.push(path.join(outDir, `Codex-${platformDir}`, "resources", binaryName));

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function resolveBinaryPath(inputPath) {
  const candidate = path.resolve(inputPath || defaultBinaryPath());
  if (!fs.existsSync(candidate)) {
    throw new Error(`Codex binary not found: ${candidate}`);
  }
  return candidate;
}

function sendJsonl(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

async function fetchModels(binaryPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let stdoutBuffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out waiting for model/list response from ${binaryPath}`));
    }, REQUEST_TIMEOUT_MS);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (err) reject(err);
      else resolve(value);
    }

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            finish(new Error(`Failed to parse app-server JSON: ${error.message}\n${line}`));
            return;
          }

          if (message.id === 2 && message.result) {
            finish(null, {
              initialize: null,
              models: message.result.data || [],
              stderr,
            });
            return;
          }

          if (message.id === 2 && message.error) {
            finish(
              new Error(
                `model/list failed: ${message.error.message || "unknown error"}\n${stderr}`.trim(),
              ),
            );
            return;
          }
        }

        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("exit", (code) => {
      if (settled) return;
      finish(
        new Error(
          `app-server exited before returning model/list (code ${code ?? "unknown"})\n${stderr}`.trim(),
        ),
      );
    });

    sendJsonl(child.stdin, {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_rebuild_verify",
          title: "Codex Rebuild Verify",
          version: "0.1.0",
        },
      },
    });
    sendJsonl(child.stdin, { method: "initialized", params: {} });
    sendJsonl(child.stdin, { id: 2, method: "model/list", params: {} });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const binaryPath = resolveBinaryPath(args.binary);
  const result = await fetchModels(binaryPath);

  const models = result.models.map((model) => model.model);
  const missing = args.require.filter((model) => !models.includes(model));
  const defaultModel =
    result.models.find((model) => model.isDefault)?.model || null;

  const output = {
    binary: binaryPath,
    defaultModel,
    models,
    required: args.require,
    missing,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Binary: ${output.binary}`);
    console.log(`Default model: ${output.defaultModel || "unknown"}`);
    console.log(`Models: ${output.models.join(", ")}`);
    if (output.required.length > 0) {
      console.log(`Required: ${output.required.join(", ")}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required model(s): ${missing.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`[verify-bundled-models] ${error.message}`);
  process.exit(1);
});
