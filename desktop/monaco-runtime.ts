import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";

// Kept behind the first file/draft boundary. All assets remain local.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme("agentmesh", { base: "vs-dark", inherit: true, rules: [], colors: {
  "editor.background": "#15232e", "editorLineNumber.foreground": "#657c8c",
  "editor.lineHighlightBackground": "#203441", "editorCursor.foreground": "#78d2c6",
} });
export function createEditor(host: HTMLElement) {
  return monaco.editor.create(host, { model: null, theme: "agentmesh",
    readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
    fontFamily: "Consolas, monospace", scrollBeyondLastLine: false, padding: { top: 15 },
    unicodeHighlight: { ambiguousCharacters: false }, ariaLabel: "Görev dosyası editörü" });
}
export const createModel = monaco.editor.createModel;
