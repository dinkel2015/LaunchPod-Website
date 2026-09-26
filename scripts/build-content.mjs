/* =====================================================================
   Static generator for /blog/ and /industries/.

     npm run build:content            write the pages
     npm run build:content -- --check fail if a committed page is stale
     node scripts/build-content.mjs --drafts --out <dir>
                                      also render drafts, into <dir>

   The marketing pages are self-extracting bundles that only show text
   after JavaScript runs, so AI crawlers and fetch tools see nothing but
   "Unpacking...". Everything this script writes is plain HTML with the
   article text in the response body and no script needed to read it.

   Sources are content/<section>/<slug>.md with a front-matter block:

     ---
     title: Podcasts for credit unions
     description: One sentence, used for <meta> and the index card.
     date: 2026-09-25
     updated: 2026-10-02        (optional)
     author: John Dinkel        (optional, defaults to LaunchPod Media)
     draft: true                (optional, skipped unless --drafts)
     ---

   Output is committed (Vercel serves the repo as-is, there is no build
   step), and the script also refreshes the generated block in
   sitemap.xml and the article list in llms.txt.
   ===================================================================== */

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://www.launchpodmedia.com";
const ORG = "LaunchPod Media";

const SECTIONS = [
  {
    id: "blog",
    title: "Blog",
    kicker: "BLOG",
    heading: "Notes on building podcasts that grow",
    intro: "Articles from LaunchPod Media on podcast strategy, production, distribution and growth.",
    schemaType: "BlogPosting",
  },
  {
    id: "industries",
    title: "Industries",
    kicker: "INDUSTRIES",
    heading: "Podcasting, industry by industry",
    intro: "How LaunchPod Media approaches branded podcasts for specific industries.",
    schemaType: "Article",
  },
];

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const DRAFTS = args.includes("--drafts");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : ROOT;

/* ---------- helpers ---------- */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const slugify = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

function parseFrontMatter(src, file) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: can't read front matter line "${line}"`);
    let v = kv[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    meta[kv[1]] = v === "true" ? true : v === "false" ? false : v;
  }
  for (const k of ["title", "description", "date"]) {
    if (!meta[k]) throw new Error(`${file}: front matter needs "${k}"`);
  }
  for (const k of ["date", "updated"]) {
    if (meta[k] && !/^\d{4}-\d{2}-\d{2}$/.test(meta[k])) throw new Error(`${file}: ${k} must be YYYY-MM-DD`);
  }
  return { meta, body: m[2] };
}

function markdown() {
  const md = new Marked({ gfm: true });
  const seen = new Map();
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        let id = slugify(text) || "section";
        const n = seen.get(id) || 0;
        seen.set(id, n + 1);
        if (n) id += `-${n}`;
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const external = /^https?:\/\//.test(href) && !href.startsWith(ORIGIN);
        const t = title ? ` title="${esc(title)}"` : "";
        return `<a href="${esc(href)}"${t}${external ? ' rel="noopener"' : ""}>${text}</a>`;
      },
    },
  });
  return md;
}

/* ---------- page shell ---------- */

const CSS = `
:root{--bg:#08060f;--bg-2:#0e0b1a;--card:#141023;--card-2:#1b1630;--line:#2a2440;--text:#f4f1fb;--muted:#b3adc8;--dim:#958fab;--pink:#FF2EA0;--purple:#6E2BF2;--cyan:#12C8D8;--grad:linear-gradient(95deg,#FF2EA0,#6E2BF2 55%,#12C8D8)}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:400 17px/1.6 'Instrument Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow-wrap:break-word}
a{color:inherit;text-decoration:none}
h1,h2,h3{font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;letter-spacing:-.03em;line-height:1.1}
:focus-visible{outline:2px solid var(--cyan);outline-offset:3px;border-radius:6px}
.wrap{max-width:1240px;margin:0 auto;padding:0 16px}
@media(min-width:600px){.wrap{padding:0 24px}}
@media(min-width:900px){.wrap{padding:0 48px}}
.btn{display:inline-flex;align-items:center;justify-content:center;height:42px;padding:0 20px;border-radius:999px;font:600 15px 'Space Grotesk',sans-serif;background:var(--grad);color:#fff}
.footer-logo{height:24px;width:auto;display:block}
.kicker{font:400 13px/1 'Space Mono',ui-monospace,monospace;letter-spacing:.08em;color:var(--cyan);margin-bottom:16px}
main{padding:56px 0 88px}
@media(min-width:900px){main{padding:88px 0 120px}}
.index h1{font-size:clamp(36px,6vw,60px);max-width:820px}
.index .lede{color:var(--muted);font-size:18px;max-width:640px;margin-top:20px}
.list{display:grid;gap:16px;margin-top:48px;max-width:820px}
.list a{display:block;padding:26px;background:var(--card);border:1px solid var(--line);border-radius:20px}
.list a:hover{border-color:#4a2fa0}
.list h2{font-size:24px}
.list p{color:var(--muted);font-size:16px;margin-top:8px}
.list time{display:block;font:400 12px 'Space Mono',monospace;color:var(--dim);margin-top:14px}
.empty{color:var(--dim);margin-top:40px}
.crumbs{font:400 13px 'Space Mono',monospace;color:var(--dim);margin-bottom:28px}
.crumbs a{text-decoration:underline;text-underline-offset:3px}
article{max-width:720px}
article header h1{font-size:clamp(34px,5.5vw,54px)}
article header .dek{color:var(--muted);font-size:19px;margin-top:18px}
.byline{font:400 13px 'Space Mono',monospace;color:var(--dim);margin-top:22px;padding-bottom:28px;border-bottom:1px solid var(--line)}
.prose{margin-top:36px}
.prose>*+*{margin-top:1.1em}
.prose h2{font-size:30px;margin-top:1.9em}
.prose h3{font-size:22px;margin-top:1.6em}
.prose a{color:var(--cyan);text-decoration:underline;text-underline-offset:3px}
.prose ul,.prose ol{padding-left:1.3em}
.prose li+li{margin-top:.4em}
.prose blockquote{border-left:3px solid var(--purple);padding-left:18px;color:var(--muted)}
.prose code{font:400 .9em 'Space Mono',monospace;background:var(--card-2);padding:2px 6px;border-radius:6px}
.prose pre{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;overflow-x:auto}
.prose pre code{background:none;padding:0}
.prose img{max-width:100%;height:auto;border-radius:14px}
.prose hr{border:0;border-top:1px solid var(--line);margin:2.2em 0}
.prose table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:15px}
.prose th,.prose td{border:1px solid var(--line);padding:10px 12px;text-align:left}
.prose th{background:var(--card-2)}
.cta{margin-top:56px;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:20px}
.cta h2{font-size:24px}
.cta p{color:var(--muted);margin:8px 0 18px}
footer{border-top:1px solid #1d1830;padding:48px 0}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:32px;font-size:14px}
footer p{color:var(--dim);max-width:320px;margin-top:10px}
footer nav{display:flex;flex-wrap:wrap;gap:40px 64px}
footer nav div{display:flex;flex-direction:column;gap:10px}
footer nav span{font:400 12px 'Space Mono',monospace;color:var(--dim)}
`.trim();

/* The site-wide menu bar lives in partials/site-nav.html. It is stamped
   into every generated page and into the hand-written pages listed in
   SYNCED_PAGES, so the logo and links can't drift between them. */
const NAV_PARTIAL = await readFile(join(ROOT, "partials", "site-nav.html"), "utf8");
const SYNCED_PAGES = [{ file: "webicast.html", current: "/webicast", cta: "#pricing" }];

function siteNav(current, cta = "/portal") {
  let html = NAV_PARTIAL.trim().replaceAll("{{cta}}", cta);
  if (current) {
    const link = `<a href="${current}">`;
    const i = html.indexOf(link); // first match is the desktop links row
    if (i >= 0) html = html.slice(0, i) + `<a href="${current}" aria-current="page">` + html.slice(i + link.length);
  }
  return `<!-- site-nav:start (generated from partials/site-nav.html by scripts/build-content.mjs) -->\n${html}\n<!-- site-nav:end -->`;
}

function shell({ title, description, path, current, ogType = "website", jsonLd, body }) {
  const url = ORIGIN + path;
  return `<!DOCTYPE html>
<!-- Generated by scripts/build-content.mjs from content/. Edit the Markdown, not this file. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/assets/favicon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="${ORG}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Instrument+Sans:wght@400;500;600&family=Space+Mono&display=swap">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
</head>
<body>
${siteNav(current)}
${body}
<footer>
  <div class="wrap">
    <div><img class="footer-logo" src="/assets/lpm-logo.png" alt="LPM" width="38" height="24"><p>${ORG}. Podcasts built to grow — telling stories and elevating voices.</p></div>
    <nav aria-label="Footer">
      <div><span>Services</span><a href="/launch">Launch</a><a href="/pods">Pods</a><a href="/webicast">Webicast</a><a href="/postcast">Postcast</a></div>
      <div><span>Read</span><a href="/industries">Industries</a><a href="/blog">Blog</a><a href="/resources">Resources</a></div>
      <div><span>Company</span><a href="/">Home</a></div>
    </nav>
  </div>
</footer>
</body>
</html>
`;
}

const orgLd = {
  "@type": "Organization",
  name: ORG,
  url: ORIGIN + "/",
  logo: ORIGIN + "/assets/lpm-logo.png",
};

function articlePage(section, a) {
  const path = `/${section.id}/${a.slug}`;
  const body = `<main>
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/${section.id}">${section.title}</a></nav>
    <article>
      <header>
        <h1>${esc(a.title)}</h1>
        <p class="dek">${esc(a.description)}</p>
        <p class="byline">By ${esc(a.author)} · <time datetime="${a.date}">${fmtDate(a.date)}</time>${
          a.updated ? ` · Updated <time datetime="${a.updated}">${fmtDate(a.updated)}</time>` : ""
        }</p>
      </header>
      <div class="prose">
${a.html.trim()}
      </div>
      <aside class="cta">
        <h2>Talk to ${ORG}</h2>
        <p>We plan, produce and grow branded podcasts. See how a show would work for your team.</p>
        <a href="/launch" class="btn">See how Launch works</a>
      </aside>
    </article>
  </div>
</main>`;
  return shell({
    title: `${a.title} | ${ORG}`,
    description: a.description,
    path,
    current: null,
    ogType: "article",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": section.schemaType,
          headline: a.title,
          description: a.description,
          datePublished: a.date,
          dateModified: a.updated || a.date,
          author: a.author === ORG ? orgLd : { "@type": "Person", name: a.author },
          publisher: orgLd,
          mainEntityOfPage: ORIGIN + path,
          image: ORIGIN + "/assets/og-image.png",
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: ORIGIN + "/" },
            { "@type": "ListItem", position: 2, name: section.title, item: `${ORIGIN}/${section.id}` },
            { "@type": "ListItem", position: 3, name: a.title, item: ORIGIN + path },
          ],
        },
      ],
    },
    body,
  });
}

function indexPage(section, articles) {
  const path = `/${section.id}`;
  const items = articles
    .map(
      (a) => `      <a href="/${section.id}/${a.slug}">
        <h2>${esc(a.title)}</h2>
        <p>${esc(a.description)}</p>
        <time datetime="${a.date}">${fmtDate(a.date)}</time>
      </a>`
    )
    .join("\n");
  const body = `<main class="index">
  <div class="wrap">
    <p class="kicker">${section.kicker}</p>
    <h1>${esc(section.heading)}</h1>
    <p class="lede">${esc(section.intro)}</p>
${articles.length ? `    <div class="list">\n${items}\n    </div>` : `    <p class="empty">The first articles are on their way.</p>`}
  </div>
</main>`;
  return shell({
    title: `${section.title} | ${ORG}`,
    description: section.intro,
    path,
    current: null,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${section.title} | ${ORG}`,
      description: section.intro,
      url: ORIGIN + path,
      publisher: orgLd,
      hasPart: articles.map((a) => ({ "@type": section.schemaType, headline: a.title, url: `${ORIGIN}/${section.id}/${a.slug}` })),
    },
    body,
  });
}

/* ---------- build ---------- */

async function loadSection(section) {
  const dir = join(ROOT, "content", section.id);
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".md")).sort() : [];
  const out = [];
  for (const f of files) {
    const { meta, body } = parseFrontMatter(await readFile(join(dir, f), "utf8"), `content/${section.id}/${f}`);
    if (meta.draft && !DRAFTS) continue;
    const slug = f.replace(/\.md$/, "");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`content/${section.id}/${f}: file name must be a lowercase-hyphenated slug`);
    out.push({
      slug,
      title: meta.title,
      description: meta.description,
      date: meta.date,
      updated: meta.updated,
      author: meta.author || ORG,
      html: markdown().parse(body),
    });
  }
  return out.sort((a, b) => (b.date + b.slug).localeCompare(a.date + a.slug));
}

function sitemapBlock(built) {
  const lines = [];
  for (const { section, articles } of built) {
    lines.push(`  <url><loc>${ORIGIN}/${section.id}</loc></url>`);
    for (const a of articles) {
      lines.push(`  <url><loc>${ORIGIN}/${section.id}/${a.slug}</loc><lastmod>${a.updated || a.date}</lastmod></url>`);
    }
  }
  return lines.join("\n");
}

function llmsBlock(built) {
  const parts = [];
  for (const { section, articles } of built) {
    parts.push(`## ${section.title}\n\n- [${section.title} index](${ORIGIN}/${section.id}): ${section.intro}`);
    for (const a of articles) parts[parts.length - 1] += `\n- [${a.title}](${ORIGIN}/${section.id}/${a.slug}): ${a.description}`;
  }
  return parts.join("\n\n");
}

function replaceBlock(text, startMark, endMark, inner, file) {
  const s = text.indexOf(startMark), e = text.indexOf(endMark);
  if (s < 0 || e < s) throw new Error(`${file}: markers ${startMark} / ${endMark} not found`);
  return text.slice(0, s + startMark.length) + "\n" + inner + "\n" + text.slice(e);
}

const built = [];
const files = new Map(); // relative path -> contents

for (const section of SECTIONS) {
  const articles = await loadSection(section);
  built.push({ section, articles });
  files.set(`${section.id}/index.html`, indexPage(section, articles));
  for (const a of articles) files.set(`${section.id}/${a.slug}.html`, articlePage(section, a));
}

for (const [file, start, end, inner] of [
  ["sitemap.xml", "<!-- content:start -->", "<!-- content:end -->", sitemapBlock(built)],
  ["llms.txt", "<!-- content:start -->", "<!-- content:end -->", llmsBlock(built)],
]) {
  files.set(file, replaceBlock(await readFile(join(ROOT, file), "utf8"), start, end, inner, file));
}

for (const page of SYNCED_PAGES) {
  const text = await readFile(join(ROOT, page.file), "utf8");
  const s = text.indexOf("<!-- site-nav:start"), e = text.indexOf("<!-- site-nav:end -->");
  if (s < 0 || e < s) throw new Error(`${page.file}: site-nav markers not found`);
  files.set(page.file, text.slice(0, s) + siteNav(page.current, page.cta) + text.slice(e + "<!-- site-nav:end -->".length));
}

if (CHECK) {
  const stale = [];
  for (const [rel, text] of files) {
    const p = join(ROOT, rel);
    if (!existsSync(p) || (await readFile(p, "utf8")) !== text) stale.push(rel);
  }
  // Pages whose Markdown was deleted should be gone too.
  for (const section of SECTIONS) {
    const dir = join(ROOT, section.id);
    if (!existsSync(dir)) continue;
    for (const f of await readdir(dir)) if (!files.has(`${section.id}/${f}`)) stale.push(`${section.id}/${f} (no source)`);
  }
  if (stale.length) {
    console.error(`Generated content is stale. Run: npm run build:content\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`content up to date (${files.size} files)`);
} else {
  for (const section of SECTIONS) await rm(join(OUT, section.id), { recursive: true, force: true });
  for (const [rel, text] of files) {
    await mkdir(join(OUT, rel, ".."), { recursive: true });
    await writeFile(join(OUT, rel), text);
  }
  const n = built.reduce((t, b) => t + b.articles.length, 0);
  console.log(`wrote ${files.size} files (${n} article${n === 1 ? "" : "s"}) to ${OUT}`);
}
