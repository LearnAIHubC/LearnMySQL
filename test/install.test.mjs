import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "bin", "install.mjs");

function runInstaller(skillsDir, extraArgs = []) {
  return spawnSync(process.execPath, [installer, "--dest", skillsDir, "--no-bin", ...extraArgs], {
    encoding: "utf8",
  });
}

test("installs the complete skill into a custom destination", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-mysql-install-"));
  try {
    const skillsDir = path.join(tempDir, "skills");
    const result = runInstaller(skillsDir);
    const installDir = path.join(skillsDir, "mysql-ops");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(installDir, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(installDir, "agents", "openai.yaml")), true);
    assert.equal(fs.existsSync(path.join(installDir, "scripts", "mysql-ops.mjs")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("repairs an existing partial installation without --force", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-mysql-install-"));
  try {
    const skillsDir = path.join(tempDir, "skills");
    const installDir = path.join(skillsDir, "mysql-ops");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "SKILL.md"), "name: mysql-ops\n");

    const result = runInstaller(skillsDir);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(installDir, "scripts", "mysql-ops.mjs")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("keeps an existing complete installation without --force", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-mysql-install-"));
  try {
    const skillsDir = path.join(tempDir, "skills");
    const first = runInstaller(skillsDir);
    assert.equal(first.status, 0, first.stderr);

    const installedCli = path.join(skillsDir, "mysql-ops", "scripts", "mysql-ops.mjs");
    fs.writeFileSync(installedCli, "existing\n");
    const second = runInstaller(skillsDir);

    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already installed/u);
    assert.equal(fs.readFileSync(installedCli, "utf8"), "existing\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("refuses to replace an unrelated skill directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-mysql-install-"));
  try {
    const skillsDir = path.join(tempDir, "skills");
    const installDir = path.join(skillsDir, "mysql-ops");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "SKILL.md"), "name: another-skill\n");

    const result = runInstaller(skillsDir, ["--force"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not look like LearnMySQL/u);
    assert.equal(fs.readFileSync(path.join(installDir, "SKILL.md"), "utf8"), "name: another-skill\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
