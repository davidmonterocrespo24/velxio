import { useEffect, type ReactElement } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { EditorPage } from './pages/EditorPage';
import { ExamplesPage } from './pages/ExamplesPage';
// Login, Register, ForgotPassword, ResetPassword, Admin, UserProfile,
// Project, ProjectById — moved to the pro overlay in Phase 3 of the
// OSS split. They register themselves via registerProRoutes() inside
// mountPro() and appear under /login, /admin, /:username etc. only when
// the overlay is loaded.
import { ExampleDetailPage } from './pages/ExampleDetailPage';
import { ExampleEditorPage } from './pages/ExampleEditorPage';
import { ImageToCodePage } from './pages/ImageToCodePage';
import { LocaleSync } from './i18n/LocaleSync';
import { NON_DEFAULT_LOCALES } from './i18n/config';
import { useProRoutes, useProRoutesSettled } from './lib/proRoutes';
import { triggerSessionCheck } from './lib/proSession';
import { MessageDialogHost } from './components/ui/MessageDialogHost';
import './App.css';

/**
 * Single source of truth for the route tree. Each entry is registered
 * twice in <Routes> below: once at the root (default locale) and once
 * nested under each non-default locale prefix (e.g. `/es/editor`).
 *
 * Index entries (path === '') belong to the locale-prefixed parent's
 * `index` slot — they render at exactly `/<locale>/`.
 */
/**
 * Root route. The OSS build IS the editor, so '/' goes straight there —
 * unless a private overlay claims the home page (velxio.dev's landing
 * registers itself with `index: true` via registerProRoutes). Until the
 * overlay's dynamic import settles we render nothing rather than redirect:
 * bouncing a velxio.dev visitor into the editor because the landing was
 * 300ms away from registering would be a race, and the prerendered SEO
 * fallback covers the blank moment for crawlers.
 */
function RootRoute(): ReactElement | null {
  const proRoutes = useProRoutes();
  const settled = useProRoutesSettled();
  const proHome = proRoutes.find((r) => r.index);
  if (proHome) return proHome.element;
  if (import.meta.env.VITE_PRO_BUILD && !settled) return null;
  return <Navigate to="/editor" replace />;
}

const ROOT_ELEMENT: ReactElement = <RootRoute />;

const ROUTES: { path: string; element: ReactElement; index?: boolean }[] = [
  { path: '/', element: ROOT_ELEMENT, index: true },
  { path: 'editor', element: <EditorPage /> },
  { path: 'examples', element: <ExamplesPage /> },
  // /examples/<id> = SEO landing (preview, badges, "Open in Simulator" CTA).
  // /example/<id>  = live editor with the example pre-loaded; the URL
  //                  stays pinned so links are shareable + bookmarkable.
  // Singular vs plural is intentional — Google indexes the plural landings.
  { path: 'examples/:exampleId', element: <ExampleDetailPage /> },
  { path: 'example/:exampleId', element: <ExampleEditorPage /> },
  // Standalone tool: image to monochrome C byte array for OLED displays.
  { path: 'tools/image-to-code', element: <ImageToCodePage /> },
  // Everything a VISITOR sees — landing, about, pricing, docs, the SEO
  // simulator landings, version showcases — moved to the pro overlay
  // (registerProRoutes, see pro pages/marketing). The OSS build is the
  // editor; it ships no marketing site.
];

/**
 * The default locale (English) is served at the root with NO `/en` prefix, so
 * `/en/...` matches no route and renders blank. People reasonably guess `/en/`
 * by analogy with `/es/`, `/zh-cn/`, … — redirect them to the prefix-free path
 * (`/en/project/x` → `/project/x`, `/en` → `/`) instead of a blank page. This
 * keeps the canonical no-prefix English URLs (good for SEO) while handling the
 * guessed ones gracefully.
 */
function EnPrefixRedirect() {
  const { pathname, search, hash } = useLocation();
  const stripped = pathname.replace(/^\/en(?=\/|$)/, '');
  return <Navigate to={(stripped || '/') + search + hash} replace />;
}

function App() {
  // Pro overlay registers extra routes (login, register, admin, profile,
  // project-by-slug, …) via registerProRoutes() inside mountPro(). The
  // subscription is sync external store, so any registration after the
  // initial render triggers a re-render — no Not-Found flash for routes
  // the overlay was about to add.
  const proRoutes = useProRoutes();
  // Index entries from the overlay are rendered by RootRoute (the OSS '/'
  // slot); mapping them here too would mount a second conflicting Route.
  const allRoutes = [...ROUTES, ...proRoutes.filter((r) => !r.index)];

  useEffect(() => {
    // Pro overlay's mountPro() registers a session-check callback that
    // resolves the JWT cookie into a user object. No-op in OSS without
    // the overlay.
    triggerSessionCheck();
    // #root-seo is a static SEO fallback in index.html (position:absolute,
    // visibility:hidden). It still contributes to document scrollHeight, so
    // every page got a phantom scroll the size of the prerendered SEO body.
    document.getElementById('root-seo')?.remove();
  }, []);

  return (
    <Router>
      <LocaleSync>
        <Routes>
          {/* Default locale (English) — no URL prefix. */}
          {allRoutes.map((r) =>
            r.index ? (
              <Route key="root" path="/" element={r.element} />
            ) : (
              <Route key={r.path} path={`/${r.path}`} element={r.element} />
            )
          )}

          {/*
            Non-default locales — same routes nested under `/<locale>/`.
            We register one branch per locale rather than a `:lang` param
            so React Router doesn't accidentally swallow real top-level
            paths like `/circuit-simulator` as a locale segment.
          */}
          {NON_DEFAULT_LOCALES.map((locale) => (
            <Route key={`locale-${locale}`} path={`/${locale}`}>
              {allRoutes.map((r) =>
                r.index ? (
                  <Route key={`${locale}-root`} index element={r.element} />
                ) : (
                  <Route
                    key={`${locale}-${r.path}`}
                    path={r.path}
                    element={r.element}
                  />
                )
              )}
            </Route>
          ))}

          {/* `/en/...` is the default locale spelled out — redirect to the
              canonical prefix-free path instead of rendering a blank page. */}
          <Route path="/en/*" element={<EnPrefixRedirect />} />
        </Routes>
      </LocaleSync>
      {/* Global alert() replacement — opened from anywhere (React or plain
          .ts) via showMessageDialog() in store/useMessageDialogStore. */}
      <MessageDialogHost />
    </Router>
  );
}

export default App;
