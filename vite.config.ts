import { defineConfig } from "vite";

export default defineConfig({ root: "desktop", base: "./", build: { outDir: "../dist/renderer", emptyOutDir: true } });
