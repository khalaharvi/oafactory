import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="wrap notfound">
      <p className="eyebrow">404</p>
      <h1>That page is not here.</h1>
      <p><Link href="/">Home</Link> or <Link href="/docs">the docs</Link>.</p>
    </section>
  );
}
