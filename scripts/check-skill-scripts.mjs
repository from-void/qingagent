#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const IMPORT_RE =
  /\bimport\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir, repoRoot, errors) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    errors.push(`Cannot read skills directory ${relative(repoRoot, dir)}: ${error.message}`);
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path, repoRoot, errors));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function isInScriptsDir(path) {
  return path.split(sep).includes("scripts");
}

function isAllowedSpecifier(specifier) {
  return specifier.startsWith("node:") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:");
}

function checkImports(file, repoRoot, errors) {
  if (![".js", ".mjs", ".cjs"].includes(extname(file))) return;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || isAllowedSpecifier(specifier)) continue;
    errors.push(
      `${relative(repoRoot, file)} imports/requires non-bundled package "${specifier}". ` +
        "Skill scripts may only use node: builtins or relative bundled files.",
    );
  }
}

export function checkSkillScripts(repoRootInput = process.cwd()) {
  const repoRoot = resolve(repoRootInput);
  const skillsRoot = join(repoRoot, "packages", "core", "skills");
  const errors = [];

  for (const file of walk(skillsRoot, repoRoot, errors).filter(isInScriptsDir)) {
    const rel = relative(repoRoot, file);
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    if (extname(file) === ".py") {
      errors.push(`${rel} is a Python skill script. Skill scripts must be JS and in-process-first.`);
    }
    checkImports(file, repoRoot, errors);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkSkillScripts(process.argv[2] ?? process.cwd());
  if (errors.length > 0) {
    console.error("Skill script guard failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Skill script guard passed.");
  }
}
