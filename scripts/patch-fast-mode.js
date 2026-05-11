#!/usr/bin/env node
/**
 * Post-build patch: force-enable Fast mode (speed selector).
 *
 * Different Codex desktop versions have used different gates:
 *   - statsig_default_enable_features.fast_mode
 *   - authMethod !== "chatgpt" checks
 *   - model metadata / featureRequirements checks
 *
 * This patch scans the platform webview chunks and removes all known Fast mode
 * gates while keeping the matching AST patterns narrow.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

const FEATURE_STORE_KEY = "statsig_default_enable_features";
const FAST_MODE_KEY = "fast_mode";
const SPEED_TIER_KEY = "additionalSpeedTiers";
const FEATURE_REQUIREMENTS_KEY = "featureRequirements";

function pushPatch(patches, patch) {
  if (patches.some((p) => p.start === patch.start)) return;
  patches.push(patch);
}

function replaceFunctionBodyWithTrue(node, source, patches, id) {
  if (node.body?.type !== "BlockStatement") return false;

  const bodySrc = source.slice(node.body.start + 1, node.body.end - 1).trim();
  if (bodySrc === "return!0") return true;

  pushPatch(patches, {
    id,
    start: node.body.start + 1,
    end: node.body.end - 1,
    replacement: "return!0",
    original: bodySrc,
  });
  return true;
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const funcSrc = source.slice(node.start, node.end);

    if (
      funcSrc.includes(SPEED_TIER_KEY) &&
      funcSrc.includes(".includes(") &&
      replaceFunctionBodyWithTrue(node, source, patches, "fast_tier_model_check")
    ) {
      return;
    }

    if (
      funcSrc.includes(FEATURE_REQUIREMENTS_KEY) &&
      funcSrc.includes(FAST_MODE_KEY) &&
      funcSrc.includes("chatgpt") &&
      replaceFunctionBodyWithTrue(node, source, patches, "fast_mode_requirements_check")
    ) {
      return;
    }

    if (
      !funcSrc.includes(FAST_MODE_KEY) ||
      (!funcSrc.includes("authMethod") && !funcSrc.includes(FEATURE_STORE_KEY))
    ) {
      return;
    }

    walk(node, (child) => {
      if (child.type === "BinaryExpression" && child.operator === "!==") {
        const childSrc = source.slice(child.start, child.end);
        if (!childSrc.includes("authMethod") || !childSrc.includes("chatgpt")) return;
        if (childSrc === "!1") return;

        pushPatch(patches, {
          id: "fast_mode_auth_gate",
          start: child.start,
          end: child.end,
          replacement: "!1",
          original: childSrc,
        });
        return;
      }

      if (child.type !== "LogicalExpression" || child.operator !== "&&") return;

      const left = child.left;
      const right = child.right;
      if (!left || left.type !== "BinaryExpression" || left.operator !== "===") return;

      const lr = left.right;
      if (
        !lr ||
        lr.type !== "UnaryExpression" ||
        lr.operator !== "!" ||
        lr.argument?.value !== 0
      ) {
        return;
      }

      const leftSrc = source.slice(left.left.start, left.left.end);
      if (!leftSrc.includes(FAST_MODE_KEY)) return;
      if (!right || right.type !== "CallExpression" || right.arguments.length !== 1) return;

      const exprSrc = source.slice(child.start, child.end);
      if (exprSrc === "!0") return;

      pushPatch(patches, {
        id: "fast_mode_statsig_gate",
        start: child.start,
        end: child.end,
        replacement: "!0",
        original: exprSrc,
      });
    });
  });

  return patches;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      const hasAuthGate = src.includes("authMethod") && src.includes(FAST_MODE_KEY);
      const hasLegacyGate = src.includes(FEATURE_STORE_KEY) && src.includes(FAST_MODE_KEY);
      const hasMetadataGate =
        src.includes(SPEED_TIER_KEY) && src.includes(FEATURE_REQUIREMENTS_KEY);
      if (hasAuthGate || hasLegacyGate || hasMetadataGate) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");

    const t0 = Date.now();
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      continue;
    }

    const patches = collectPatches(ast, source);
    if (patches.length === 0) continue;

    console.log(
      `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
    );

    if (isCheck) {
      for (const p of patches) {
        console.log(`    [?] ${p.id} offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`    * ${p.id}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
  }

  if (totalPatched > 0) {
    console.log(`  [ok] ${totalPatched} fast-mode gate(s) patched`);
  } else {
    console.log("  [ok] fast_mode gates already patched or absent");
  }
}

main();
