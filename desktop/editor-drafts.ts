export interface EditorDraft { path: string; content: string; baseContent: string; baseDigest: string }
export const maxEditorTabs = 20;
const maxDraftBytes = 4 * 1024 * 1024;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function draftKey(scope: string): string { return `agentmesh.editor.v1:${scope}`; }

export function readDrafts(storage: DraftStorage, scope: string): EditorDraft[] {
  const text = storage.getItem(draftKey(scope));
  if (text === null) return [];
  if (new TextEncoder().encode(text).length > maxDraftBytes) throw new Error("Taslak kaydı boyut sınırını aşıyor");
  const value = JSON.parse(text) as { version?: number; drafts?: EditorDraft[] };
  if (value?.version !== 1 || !Array.isArray(value.drafts) || value.drafts.length > maxEditorTabs) throw new Error("Taslak kaydı okunamadı");
  const paths = new Set<string>();
  for (const draft of value.drafts) {
    if (!draft || typeof draft.path !== "string" || !draft.path || draft.path.length > 1024 || paths.has(draft.path)
      || typeof draft.content !== "string" || typeof draft.baseContent !== "string"
      || typeof draft.baseDigest !== "string" || !/^[a-f0-9]{64}$/.test(draft.baseDigest)) throw new Error("Geçersiz taslak kaydı");
    paths.add(draft.path);
  }
  return value.drafts;
}

export function writeDrafts(storage: DraftStorage, scope: string, drafts: EditorDraft[]): void {
  const text = JSON.stringify({ version: 1, drafts });
  if (drafts.length > maxEditorTabs || new TextEncoder().encode(text).length > maxDraftBytes) throw new Error("Taslaklar 4 MiB sınırını aşıyor; dosyaları kaydedin");
  if (drafts.length) storage.setItem(draftKey(scope), text);
  else storage.removeItem(draftKey(scope));
}
