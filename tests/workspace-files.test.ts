import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listWorkspace, readWorkspaceFile, saveWorkspaceFile } from "../src/core/workspace-files.js";

test("workspace file access rejects traversal, protected paths, symlinks, binaries and stale saves", () => {
  const base = mkdtempSync(join(tmpdir(), "mesh-files-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(outside);
  writeFileSync(join(root, "src", "code.ts"), "const value = 1;\r\n");
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  try {
    assert.deepEqual(listWorkspace(root).map((entry) => entry.name), ["src"]);
    for (const path of ["../outside/secret.txt", "src/../../outside/secret.txt", ".git/config", "linked/secret.txt", "C:\\private", "src/code.ts:stream"]) {
      assert.throws(() => readWorkspaceFile(root, path));
    }
    const initial = readWorkspaceFile(root, "src/code.ts");
    assert.equal(initial.content, "const value = 1;\r\n");
    assert.throws(() => saveWorkspaceFile(root, initial.path, "changed", "stale", ["src/**"]), /disk üzerinde değişti/);
    assert.throws(() => saveWorkspaceFile(root, initial.path, "changed", initial.digest, ["docs/**"]), /kapsamı dışında/);
    const saved = saveWorkspaceFile(root, initial.path, "const value = 2;\r\n", initial.digest, ["src/**"]);
    assert.notEqual(saved.digest, initial.digest);
    assert.equal(readFileSync(join(root, "src", "code.ts"), "utf8"), saved.content);
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "invalid.txt"), Buffer.from([0xff, 0xfe]));
    writeFileSync(join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));
    for (const path of ["binary.dat", "invalid.txt", "large.txt"]) assert.throws(() => readWorkspaceFile(root, path));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
