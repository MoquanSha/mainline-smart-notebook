import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(fileURLToPath(import.meta.url));
const runtimeIdentity = createRequire(import.meta.url)('./electron/runtime-identity.cjs') as {
  getBuild: (root: string) => Record<string, string | number>;
  frontendSourceId: (root: string) => string;
};
const build = runtimeIdentity.getBuild(root);

export default defineConfig({
  plugins: [react(), {
    name: 'mainline-build-identity',
    generateBundle(_options, bundle) {
      const assets = Object.fromEntries(Object.entries(bundle).map(([name, item]) => [name,
        createHash('sha256').update(item.type === 'chunk' ? item.code : item.source).digest('hex')]));
      this.emitFile({ type: 'asset', fileName: 'build-identity.json', source: JSON.stringify({ ...build,
        frontendSourceId: runtimeIdentity.frontendSourceId(root), assets }) });
    },
  }],
  define: { 'import.meta.env.VITE_MAINLINE_SOURCE_ID': JSON.stringify(build.sourceId) },
  server: {
    host: "127.0.0.1",
    port: Number(build.devPort),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.SMART_NOTEBOOK_PORT || Number(build.backendPort)}`,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
