import { useEffect, useRef } from 'react';

export interface SEOMeta {
  title: string;
  description: string;
  url: string;
  ogImage?: string;
  /** Module-level constant: injected once on mount, removed on unmount. */
  jsonLd?: object | object[];
  /** If true, sets robots meta to "noindex, nofollow" to prevent indexing. */
  noindex?: boolean;
}

function qs(selector: string): HTMLMetaElement | null {
  return document.querySelector(selector) as HTMLMetaElement | null;
}

/**
 * Updates document.title, meta description, OG/Twitter tags, and canonical
 * to reflect the current page. Restores originals on unmount.
 *
 * jsonLd (if provided) is injected as a <script type="application/ld+json">
 * once on mount and removed on unmount. Pass a module-level constant to avoid
 * unnecessary re-injection.
 */
export function useSEO({ title, description, url, ogImage, jsonLd, noindex }: SEOMeta) {
  const scriptRef = useRef<HTMLScriptElement | null>(null);

  useEffect(() => {
    const origTitle = document.title;
    const descEl = qs('meta[name="description"]');
    const robotsEl = qs('meta[name="robots"]');
    const ogTitleEl = qs('meta[property="og:title"]');
    const ogDescEl = qs('meta[property="og:description"]');
    const ogUrlEl = qs('meta[property="og:url"]');
    const ogImgEl = qs('meta[property="og:image"]');
    const twTitleEl = qs('meta[name="twitter:title"]');
    const twDescEl = qs('meta[name="twitter:description"]');
    const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;

    const get = (el: HTMLMetaElement | null) => el?.getAttribute('content') ?? '';
    const set = (el: HTMLMetaElement | null, v: string) => el?.setAttribute('content', v);

    const origDesc = get(descEl);
    const origRobots = get(robotsEl);
    const origOgTitle = get(ogTitleEl);
    const origOgDesc = get(ogDescEl);
    const origOgUrl = get(ogUrlEl);
    const origOgImg = get(ogImgEl);
    const origTwTitle = get(twTitleEl);
    const origTwDesc = get(twDescEl);
    const origCanonical = canonicalEl?.getAttribute('href') ?? '';

    // If no <link rel="canonical"> exists yet, create one so each SPA route
    // gets its own canonical (avoids all routes appearing to point back to /).
    let createdCanonical = false;
    let activeCanonical: HTMLLinkElement | null = canonicalEl as HTMLLinkElement | null;
    if (!activeCanonical) {
      activeCanonical = document.createElement('link') as HTMLLinkElement;
      activeCanonical.rel = 'canonical';
      document.head.appendChild(activeCanonical);
      createdCanonical = true;
    }

    // Apply
    document.title = title;
    set(descEl, description);
    if (noindex) {
      set(robotsEl, 'noindex, nofollow');
    }
    set(ogTitleEl, title);
    set(ogDescEl, description);
    set(ogUrlEl, url);
    if (ogImage) set(ogImgEl, ogImage);
    set(twTitleEl, title);
    set(twDescEl, description);
    activeCanonical.setAttribute('href', url);

    // Inject JSON-LD once (module-level constants don't change)
    if (jsonLd && !scriptRef.current) {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-seo-page', '1');
      script.textContent = JSON.stringify(Array.isArray(jsonLd) ? jsonLd : [jsonLd]);
      document.head.appendChild(script);
      scriptRef.current = script;
    }

    return () => {
      document.title = origTitle;
      set(descEl, origDesc);
      if (noindex) set(robotsEl, origRobots);
      set(ogTitleEl, origOgTitle);
      set(ogDescEl, origOgDesc);
      set(ogUrlEl, origOgUrl);
      if (ogImage) set(ogImgEl, origOgImg);
      set(twTitleEl, origTwTitle);
      set(twDescEl, origTwDesc);
      if (createdCanonical && activeCanonical && document.head.contains(activeCanonical)) {
        document.head.removeChild(activeCanonical);
      } else {
        activeCanonical?.setAttribute('href', origCanonical);
      }
      if (scriptRef.current) {
        document.head.removeChild(scriptRef.current);
        scriptRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, url, ogImage, noindex]);
}
