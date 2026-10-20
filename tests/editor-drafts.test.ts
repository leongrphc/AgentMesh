import assert from "node:assert/strict";
import { test } from "node:test";
import { draftKey, readDrafts, writeDrafts } from "../desktop/editor-drafts.js";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
test("editor recovery isolates workspaces, keeps the original disk digest, and removes only saved drafts", () => {
  const store = storage();
  const draft = { path: "src/a.ts", content: "unsaved", baseContent: "original", baseDigest: "a".repeat(64) };
  writeDrafts(store, "project-a/task/worktree", [draft]);
  assert.deepEqual(readDrafts(store, "project-b/task/worktree"), []);
  assert.deepEqual(readDrafts(store, "project-a/task/worktree"), [draft]);
  writeDrafts(store, "other", [draft]);
  writeDrafts(store, "project-a/task/worktree", []);
  assert.equal(store.getItem(draftKey("project-a/task/worktree")), null);
  assert.deepEqual(readDrafts(store, "other"), [draft]);
});
test("invalid or oversized drafts and quota failures do not overwrite earlier recovery data", () => {
  const store = storage();
  const draft = { path: "a", content: "new", baseContent: "old", baseDigest: "b".repeat(64) };
  writeDrafts(store, "scope", [draft]);
  assert.throws(() => writeDrafts(store, "scope", [{ ...draft, content: "x".repeat(4 * 1024 * 1024) }]), /4 MiB/);
  assert.deepEqual(readDrafts(store, "scope"), [draft]);
  assert.throws(() => writeDrafts({ ...store, setItem() { throw new Error("QuotaExceeded"); } }, "scope", [draft]), /QuotaExceeded/);
  assert.deepEqual(readDrafts(store, "scope"), [draft]);
  store.setItem(draftKey("scope"), JSON.stringify({ version: 1, drafts: [draft, draft] }));
  assert.throws(() => readDrafts(store, "scope"), /Geçersiz/);
  store.setItem(draftKey("scope"), '{"version":2}');
  assert.throws(() => readDrafts(store, "scope"), /okunamadı/);
});
