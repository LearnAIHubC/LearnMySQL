#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "mysql-ops";
const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(dirname, "..");
const sourceSkillRoot = path.join(packageRoot, "skills", SKILL_NAME);

function usage() {
  console.log(`LearnMySQL installer

Usage:
  npx @learnaihubc/learn-mysql [options]

Options:
  --force          Replace an existing mysql-ops skill installation
  --dest <dir>     Install into a custom skills directory
  --no-bin         Do not create the mysql-ops launcher
  --help           Show this help
`);
}

function parseArgs(argv) {
  const opts = { force: false, bin: true };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--no-bin") {
      opts.bin = false;
      continue;
    }
    if (arg === "--dest") {
      if (index + 1 >= argv.length) throw new Error("Missing value for --dest");
      opts.dest = argv[++index];
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function defaultSkillsDir() {
  return path.join(codexHome(), "skills");
}

function defaultBinDir(skillsDir) {
  return path.join(path.dirname(skillsDir), "bin");
}

function ensurePackageLooksLikeSkill() {
  const skillMd = path.join(sourceSkillRoot, "SKILL.md");
  const cli = path.join(sourceSkillRoot, "scripts", "mysql-ops.mjs");
  if (!fs.existsSync(skillMd) || !fs.existsSync(cli)) {
    throw new Error(`Incomplete mysql-ops skill in package: ${sourceSkillRoot}`);
  }
}

function isLearnMysqlInstall(dir) {
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return false;
  const body = fs.readFileSync(skillMd, "utf8");
  return /^name:\s*mysql-ops\s*$/m.test(body);
}

function isCompleteLearnMysqlInstall(dir) {
  return fs.existsSync(path.join(dir, "SKILL.md"))
    && fs.existsSync(path.join(dir, "scripts", "mysql-ops.mjs"));
}

function copyFromRoot(name, destRoot) {
  const src = path.join(packageRoot, name);
  const dest = path.join(destRoot, name);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: false });
}

function copyFromSkill(name, destRoot) {
  const src = path.join(sourceSkillRoot, name);
  const dest = path.join(destRoot, name);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: false });
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeLauncher(skillsDir, dest) {
  const binDir = defaultBinDir(skillsDir);
  const launcher = path.join(binDir, "mysql-ops");
  const target = path.join(dest, "scripts", "mysql-ops.mjs");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(launcher, `#!/bin/sh
exec node ${shQuote(target)} "$@"
`);
  fs.chmodSync(launcher, 0o755);

  if (process.platform === "win32") {
    const cmdLauncher = path.join(binDir, "mysql-ops.cmd");
    fs.writeFileSync(cmdLauncher, `@echo off\r\nnode "${target}" %*\r\n`);
    return cmdLauncher;
  }

  return launcher;
}

function pathContains(dir) {
  const resolved = path.resolve(dir);
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === resolved);
}

function install(opts) {
  ensurePackageLooksLikeSkill();
  const skillsDir = path.resolve(opts.dest || defaultSkillsDir());
  const dest = path.join(skillsDir, SKILL_NAME);
  fs.mkdirSync(skillsDir, { recursive: true });

  if (fs.existsSync(dest)) {
    if (!isLearnMysqlInstall(dest)) {
      throw new Error(`Destination exists and does not look like LearnMySQL: ${dest}`);
    }
    if (!opts.force && isCompleteLearnMysqlInstall(dest)) {
      console.log(`LearnMySQL is already installed at ${dest}`);
      console.log("Run again with --force to replace it with this package version.");
      return;
    }
    if (!opts.force) {
      console.log(`Incomplete LearnMySQL installation found at ${dest}; reinstalling.`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  fs.mkdirSync(dest, { recursive: true });
  try {
    for (const name of ["SKILL.md", "agents", "scripts"]) {
      copyFromSkill(name, dest);
    }
    for (const name of ["README.md", "README_CN.md", "LICENSE"]) {
      copyFromRoot(name, dest);
    }
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }

  const launcher = opts.bin ? writeLauncher(skillsDir, dest) : null;
  console.log(`LearnMySQL installed to ${dest}`);
  if (launcher) {
    console.log(`Launcher installed to ${launcher}`);
    if (pathContains(path.dirname(launcher))) {
      console.log("Run: mysql-ops doctor");
    } else {
      console.log(`Run: ${launcher} doctor`);
      console.log(`Optional: add ${path.dirname(launcher)} to PATH to use mysql-ops directly.`);
    }
  }
  console.log("Install the official MySQL client tools, run doctor, then restart Codex and use $mysql-ops.");
}

try {
  install(parseArgs(process.argv));
} catch (err) {
  console.error(`LearnMySQL install failed: ${err.message || err}`);
  process.exit(1);
}
