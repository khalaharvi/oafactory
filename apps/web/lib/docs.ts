import fs from 'node:fs';
import path from 'node:path';
import { Marked, type Tokens } from 'marked';
import { parse as parseYaml } from 'yaml';

const DOCS_DIR = path.join(process.cwd(), '..', '..', 'docs');

export interface NavGroup { group: string; pages: Array<{ slug: string; title: string }> }
export interface Doc { slug: string; title: string; description: string; html: string; headings: Array<{ id: string; text: string }> }

function read(slug: string): { meta: { title: string; description: string }; body: string } | null {
  const file = path.join(DOCS_DIR, `${slug}.mdx`);
  if (!file.startsWith(DOCS_DIR) || !fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const meta = (m ? parseYaml(m[1]!) : {}) as { title?: string; description?: string };
  return { meta: { title: meta.title ?? slug, description: meta.description ?? '' }, body: m ? m[2]! : raw };
}

export function navigation(): NavGroup[] {
  const cfg = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, 'docs.json'), 'utf8')) as { navigation: { groups: Array<{ group: string; pages: string[] }> } };
  return cfg.navigation.groups.map((g) => ({ group: g.group, pages: g.pages.map((slug) => ({ slug, title: read(slug)?.meta.title ?? slug })) }));
}

export function allSlugs(): string[] {
  return navigation().flatMap((g) => g.pages.map((p) => p.slug));
}

const slugify = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Docs links are written Mintlify-style, from the docs root. On this site the docs live under /docs. */
const href = (h: string) => (h.startsWith('/') && !h.startsWith('/docs') ? `/docs${h === '/index' ? '' : h}` : h);

export function getDoc(slug: string): Doc | null {
  const src = read(slug);
  if (!src) return null;
  const headings: Doc['headings'] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const id = slugify(inner);
        if (depth === 2) headings.push({ id, text: inner.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${depth}>\n`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { href: h, tokens }: Tokens.Link) {
        const external = /^https?:/.test(h);
        return `<a href="${esc(href(h))}"${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
      table(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: string) => `<${tag}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
        const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('');
        return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        return `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(text)}</code></pre>\n`;
      },
    },
  });
  // Mintlify callouts become plain asides here.
  const body = src.body.replace(/<(Note|Warning|Tip|Info)>\s*([\s\S]*?)\s*<\/\1>/g, (_m, kind: string, inner: string) =>
    `<aside class="callout callout-${kind.toLowerCase()}"><strong>${kind === 'Warning' ? 'Warning' : 'Note'}</strong>\n\n${inner}\n\n</aside>`);
  return { slug, title: src.meta.title, description: src.meta.description, html: marked.parse(body, { async: false }), headings };
}
