import type { Plugin } from 'vite';

/**
 * Prevents Node.js-only modules from being bundled into the SPA browser build.
 *
 * - `node:stream`: dynamically imported in azureai provider behind `typeof window === 'undefined'`
 *   guard — dead code in browser but Rollup still resolves it.
 * - `node-fetch`: dynamically imported by klavis SDK's getFetchFn behind a runtime
 *   Node.js version check — dead code in browser since native fetch is available.
 * - `puppeteer-core` / `@puppeteer/browsers`: server-only headless-browser deps used by
 *   TowerAI token refresh. Lazily imported but still resolved by bundler.
 */
export function viteNodeModuleStub(): Plugin {
  const VIRTUAL_PREFIX = '\0node-stub:';

  /** Modules that only need a default export (lazy / guarded imports). */
  const simpleStubs = new Set([
    'node:stream',
    'node-fetch',
    'puppeteer-core',
    '@puppeteer/browsers',
  ]);

  /** Modules with top-level named imports that Rollup needs to see as exports. */
  const namedStubs: Record<string, string[]> = {
    'node:fs': ['readFileSync', 'writeFileSync'],
    'node:os': ['homedir', 'platform'],
    'node:path': ['join'],
  };

  const allStubs = new Set([...simpleStubs, ...Object.keys(namedStubs)]);

  return {
    enforce: 'pre',
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const mod = id.slice(VIRTUAL_PREFIX.length);
      const named = namedStubs[mod];
      if (named) {
        return named.map((n) => `export const ${n} = undefined;`).join('\n');
      }
      return 'export default {};';
    },
    name: 'vite-node-module-stub',
    resolveId(source) {
      if (allStubs.has(source)) {
        return { id: `${VIRTUAL_PREFIX}${source}`, moduleSideEffects: false };
      }
      return null;
    },
  };
}
