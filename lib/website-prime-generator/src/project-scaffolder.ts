/**
 * project-scaffolder.ts
 *
 * Generates the Website Prime project skeleton:
 *   package.json, vite.config.ts, tsconfig.json, index.html,
 *   src/main.tsx, src/App.tsx
 *
 * The generated project is a standard Vite + React 18 + React Router 6 SPA.
 */

import type { PrimeFile } from "./types.js";

export interface ScaffoldInput {
  siteName: string;
  seedUrl: string;
  stencilId: string;
  jobId: string;
  hasSidebar: boolean;
  primaryColor: string;
}

export function generateProjectScaffold(input: ScaffoldInput): PrimeFile[] {
  const { siteName, seedUrl, stencilId, jobId, hasSidebar, primaryColor } = input;
  const safeTitle = siteName.replace(/"/g, '\\"');

  const packageJson = {
    name: `website-prime-${jobId.slice(0, 8)}`,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite",
      build: "tsc --noEmit && vite build",
      preview: "vite preview",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "react-router-dom": "^6.26.2",
    },
    devDependencies: {
      "@types/react": "^18.3.5",
      "@types/react-dom": "^18.3.0",
      "@vitejs/plugin-react": "^4.3.1",
      typescript: "^5.5.4",
      vite: "^5.4.2",
    },
  };

  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Website Prime — Vite config
// Stencil: ${stencilId} | Job: ${jobId}
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
`;

  const tsconfig = {
    compilerOptions: {
      target: "ES2020",
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      noFallthroughCasesInSwitch: true,
    },
    include: ["src"],
  };

  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${safeTitle} — Website Prime" />
    <meta name="theme-color" content="${primaryColor}" />
    <title>${safeTitle}</title>
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

  const mainTsx = `import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './theme/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
`;

  const appTsx = `import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navigation from './components/Navigation';
import Footer from './components/Footer';
${hasSidebar ? "import Sidebar from './components/Sidebar';" : ""}
import { routes } from './router';

/**
 * App — Website Prime root
 * Source: ${seedUrl}
 * Stencil: ${stencilId}
 * Generated: ${new Date().toISOString()}
 */
export default function App() {
  return (
    <div className="app-shell" data-stencil="${stencilId}">
      <Navigation />
      <div className="app-body${hasSidebar ? " app-body--with-sidebar" : ""}">
        ${hasSidebar ? "<Sidebar />" : ""}
        <main id="main-content" className="app-main" tabIndex={-1}>
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
          </Routes>
        </main>
      </div>
      <Footer />
    </div>
  );
}
`;

  const appCss = `/* App shell layout */
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-body {
  display: flex;
  flex: 1;
}

.app-body--with-sidebar {
  display: grid;
  grid-template-columns: var(--layout-sidebar-width, 280px) 1fr;
  align-items: start;
}

.app-main {
  flex: 1;
  width: 100%;
  outline: none;
}

@media (max-width: 768px) {
  .app-body--with-sidebar {
    grid-template-columns: 1fr;
  }
}
`;

  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${primaryColor}"/>
  <text x="16" y="22" text-anchor="middle" font-size="18" font-weight="bold" fill="white" font-family="sans-serif">P</text>
</svg>`;

  return [
    { path: "package.json", content: JSON.stringify(packageJson, null, 2), kind: "json" },
    { path: "vite.config.ts", content: viteConfig, kind: "config" },
    { path: "tsconfig.json", content: JSON.stringify(tsconfig, null, 2), kind: "json" },
    { path: "index.html", content: indexHtml, kind: "html" },
    { path: "src/main.tsx", content: mainTsx, kind: "tsx" },
    { path: "src/App.tsx", content: appTsx, kind: "tsx" },
    { path: "src/App.css", content: appCss, kind: "css" },
    { path: "public/favicon.svg", content: faviconSvg, kind: "config" },
  ];
}
