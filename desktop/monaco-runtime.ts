import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";

// Kept behind the first file/draft boundary. All assets remain local.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
// Matches the slate palette in style.css (--sunken, --muted, --raised, --text).
monaco.editor.defineTheme("agentmesh", { base: "vs-dark", inherit: true, rules: [], colors: {
  "editor.background": "#12141b", "editorLineNumber.foreground": "#5d6478",
  "editor.lineHighlightBackground": "#1c202b", "editorCursor.foreground": "#e7e9f0",
  "diffEditor.insertedTextBackground": "#6ccb8f26", "diffEditor.removedTextBackground": "#f2776f26",
  "diffEditor.insertedLineBackground": "#6ccb8f14", "diffEditor.removedLineBackground": "#f2776f14",
} });
export function createEditor(host: HTMLElement) {
  return monaco.editor.create(host, { model: null, theme: "agentmesh",
    readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
    fontFamily: "Consolas, monospace", scrollBeyondLastLine: false, padding: { top: 15 },
    unicodeHighlight: { ambiguousCharacters: false }, ariaLabel: "Görev dosyası editörü" });
}
export const createModel = monaco.editor.createModel;

/** Read-only side-by-side diff of two texts; the language is taken from the file name. */
export function createDiff(host: HTMLElement, path: string, original: string, modified: string) {
  const editor = monaco.editor.createDiffEditor(host, { theme: "agentmesh", readOnly: true, originalEditable: false,
    automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5, fontFamily: "Cascadia Code, Consolas, monospace",
    scrollBeyondLastLine: false, renderSideBySide: true, ignoreTrimWhitespace: false, ariaLabel: `${path} değişiklikleri` });
  const uri = (side: string) => monaco.Uri.parse(`agentmesh-diff://${side}/${encodeURI(path)}`);
  const originalModel = monaco.editor.createModel(original, undefined, uri("before"));
  const modifiedModel = monaco.editor.createModel(modified, undefined, uri("after"));
  editor.setModel({ original: originalModel, modified: modifiedModel });
  return () => { editor.dispose(); originalModel.dispose(); modifiedModel.dispose(); };
}
