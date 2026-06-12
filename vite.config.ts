import { defineConfig } from "vite";

// The WASM module is generated into src/wasm/pkg by `npm run wasm`
// (wasm-bindgen --target web); Vite picks the .wasm file up as an asset via
// `new URL(..., import.meta.url)`, so no plugin is needed.
export default defineConfig({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      // Game server runs separately during dev (`npm run server`).
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
