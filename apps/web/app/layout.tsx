import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { SITE } from '@/lib/site';
import './globals.css';

export const metadata: Metadata = {
  title: `${SITE.name}: ${SITE.tagline}`,
  description: SITE.description,
  openGraph: { title: `${SITE.name}: ${SITE.tagline}`, description: SITE.description, type: 'website' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 21V10l6 4V10l6 4V4h6v17Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8 21v-3M13 21v-3M18 21v-3" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="brand"><Mark />{SITE.name}<span className="badge">v{SITE.version} alpha</span></Link>
            <nav aria-label="Main">
              <Link href="/docs">Docs</Link>
              <Link href="/docs/quickstart">Quickstart</Link>
              <a href={SITE.spec}>Spec</a>
              <a href={SITE.repo} className="gh">GitHub</a>
            </nav>
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div className="wrap">
            <div>
              <p className="brand"><Mark />{SITE.name}</p>
              <p className="muted">Open source under Apache 2.0. Version {SITE.version}, implementing spec v0.1 draft revision 2.</p>
            </div>
            <nav aria-label="Footer">
              <Link href="/docs">Documentation</Link>
              <Link href="/docs/reference/status">Status and limits</Link>
              <Link href="/docs/reference/conformance">Conformance</Link>
              <a href={SITE.spec}>Specification</a>
              <a href={`${SITE.repo}/blob/main/CONTRIBUTING.md`}>Contributing</a>
              <a href={`${SITE.repo}/blob/main/CHANGELOG.md`}>Changelog</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
