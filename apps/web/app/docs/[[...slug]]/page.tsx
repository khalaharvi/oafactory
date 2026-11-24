import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { allSlugs, getDoc, navigation } from '@/lib/docs';
import { SITE } from '@/lib/site';

type Params = { slug?: string[] };
const toSlug = (p: Params) => (p.slug?.length ? p.slug.join('/') : 'index');
const toHref = (slug: string) => (slug === 'index' ? '/docs' : `/docs/${slug}`);

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return allSlugs().map((s) => ({ slug: s === 'index' ? [] : s.split('/') }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const doc = getDoc(toSlug(await params));
  return doc ? { title: `${doc.title} · ${SITE.name} docs`, description: doc.description } : {};
}

export default async function DocPage({ params }: { params: Promise<Params> }) {
  const slug = toSlug(await params);
  const doc = getDoc(slug);
  if (!doc) notFound();
  const nav = navigation();
  const flat = nav.flatMap((g) => g.pages);
  const i = flat.findIndex((p) => p.slug === slug);
  const prev = flat[i - 1], next = flat[i + 1];

  return (
    <div className="docs">
      <details className="docs-nav-mobile">
        <summary>Docs menu</summary>
        <DocsNav nav={nav} current={slug} />
      </details>
      <aside className="docs-nav"><DocsNav nav={nav} current={slug} /></aside>
      <article className="docs-body">
        <p className="eyebrow">{nav.find((g) => g.pages.some((p) => p.slug === slug))?.group}</p>
        <h1>{doc.title}</h1>
        <p className="lede">{doc.description}</p>
        <div className="prose" dangerouslySetInnerHTML={{ __html: doc.html }} />
        <nav className="docs-pager" aria-label="Pagination">
          {prev ? <Link href={toHref(prev.slug)}><span>Previous</span>{prev.title}</Link> : <span />}
          {next ? <Link href={toHref(next.slug)} className="next"><span>Next</span>{next.title}</Link> : <span />}
        </nav>
      </article>
      <aside className="docs-toc">
        {doc.headings.length > 1 && (<>
          <p>On this page</p>
          <ul>{doc.headings.map((h) => <li key={h.id}><a href={`#${h.id}`}>{h.text}</a></li>)}</ul>
        </>)}
      </aside>
    </div>
  );
}

function DocsNav({ nav, current }: { nav: ReturnType<typeof navigation>; current: string }) {
  return (
    <nav aria-label="Documentation">
      {nav.map((g) => (
        <div key={g.group}>
          <p>{g.group}</p>
          <ul>
            {g.pages.map((p) => (
              <li key={p.slug}><Link href={toHref(p.slug)} aria-current={p.slug === current ? 'page' : undefined}>{p.title}</Link></li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
