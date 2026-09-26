/* =====================================================================
   Prerender the bundled marketing pages into crawlable HTML.

     node scripts/prerender-bundles.mjs            all bundle pages
     node scripts/prerender-bundles.mjs pods.html  just one

   The marketing pages are self-extracting bundles: the real markup sits
   JSON-escaped in <script type="__bundler/template"> and only appears
   after the loader runs, so a plain fetch (what AI crawlers do) reads
   "LPM Unpacking...". This renders each page in headless Chrome, walks
   the finished DOM at desktop width keeping only what is visible, and
   writes that as plain semantic HTML into <div id="lpm-static"> at the
   top of <body>.

   Visitors never see it: the loader's fixed thumbnail covers it while
   unpacking, then the loader replaces the whole <html> element. Without
   JavaScript, the <noscript> styles hide the thumbnail so the text
   version shows instead of a blank page.

   The block is stamped with a hash of the page's template, and
   `npm test` (build-content --check) fails when a template changes
   without a re-run. Needs Google Chrome, so it runs locally, not on
   Vercel.
   ===================================================================== */

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const BUNDLE_PAGES = [
  "index.html", "launch.html", "pods.html", "boost-pod.html", "production-pod.html",
  "social-pod.html", "web-pod.html", "postcast.html", "resources.html",
];

export const START = "<!-- prerender:start";
export const END = "<!-- prerender:end -->";

export function templateHash(html) {
  const m = html.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __bundler/template script");
  return createHash("sha256").update(m[1]).digest("hex").slice(0, 16);
}

/* Runs inside the page. The loader swaps document.documentElement but
   keeps window, so this timer survives the swap and reads the result. */
const EXTRACT = `<script>
(function () {
  var KEEP = { H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,P:1,A:1,UL:1,OL:1,LI:1,SECTION:1,NAV:1,HEADER:1,FOOTER:1,MAIN:1,ARTICLE:1,ASIDE:1,
    STRONG:1,EM:1,B:1,I:1,BR:1,IMG:1,TABLE:1,THEAD:1,TBODY:1,TR:1,TH:1,TD:1,BLOCKQUOTE:1,FIGURE:1,FIGCAPTION:1,DL:1,DT:1,DD:1 };
  var SKIP = { SCRIPT:1,STYLE:1,SVG:1,NOSCRIPT:1,BUTTON:1,TEMPLATE:1,IFRAME:1,VIDEO:1,AUDIO:1,CANVAS:1,INPUT:1,SELECT:1,TEXTAREA:1,HELMET:1 };
  function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  var INLINE_CTX = { A:1,P:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,LI:1,STRONG:1,EM:1,B:1,I:1,TH:1,TD:1,DT:1,DD:1,FIGCAPTION:1 };
  function walk(n, inline) {
    if (n.nodeType === 3) return esc(n.nodeValue.replace(/\\s+/g, " "));
    if (n.nodeType !== 1) return "";
    var t = n.tagName.toUpperCase();
    if (SKIP[t] || n.getAttribute("aria-hidden") === "true") return "";
    var cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return "";
    if (t === "BR") return "<br>";
    if (t === "IMG") {
      var src = n.getAttribute("src") || "";
      return src.charAt(0) === "/" && n.alt ? '<img src="' + esc(src) + '" alt="' + esc(n.alt) + '">' : "";
    }
    var childInline = inline || !!INLINE_CTX[t];
    var parts = [];
    for (var c = n.firstChild; c; c = c.nextSibling) {
      var out = walk(c, childInline);
      if (out.trim()) parts.push(out); else if (out && parts.length) parts.push(" ");
    }
    var inner = parts.join("").replace(/\\s+/g, " ").trim();
    if (!inner) return "";
    if (!KEEP[t]) {
      // Layout wrapper: drop it. Inside inline context just keep a space;
      // otherwise keep a <div> so blocks don't run together, unless it would
      // only wrap a single block child.
      if (inline) return " " + inner + " ";
      if (!/^(block|flex|grid|list-item|table)/.test(cs.display)) return inner;
      var solid = parts.filter(function (x) { return x.trim(); });
      if (solid.length === 1 && /^<(div|section|nav|header|footer|main|p|h\\d|ul|ol|table|blockquote|figure)[ >]/.test(solid[0].trim())) return solid[0].trim();
      return "<div>" + inner + "</div>";
    }
    var tag = t.toLowerCase(), attrs = "";
    if (t === "A" && n.getAttribute("href")) attrs = ' href="' + esc(n.getAttribute("href")) + '"';
    if (n.getAttribute("aria-label") && (t === "NAV" || t === "A")) attrs += ' aria-label="' + esc(n.getAttribute("aria-label")) + '"';
    return "<" + tag + attrs + ">" + inner + "</" + tag + ">";
  }
  var tries = 0;
  var timer = setInterval(function () {
    var h1 = document.querySelector("x-dc h1, body h1");
    if (!h1 && ++tries < 60) return;
    clearInterval(timer);
    setTimeout(function () {
      var root = document.querySelector("x-dc") || document.body;
      var html = walk(root, false).trim();
      var out = document.createElement("div");
      out.id = "lpm-prerender-out";
      out.setAttribute("data-html", btoa(unescape(encodeURIComponent(html))));
      document.body.appendChild(out);
    }, 800);
  }, 250);
})();
</script>`;

const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".js": "text/javascript" };

function serve(page) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p === "/") p = "/index.html";
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
      try {
        let body = await readFile(file);
        if (p === "/" + page) body = Buffer.from(body.toString("utf8").replace("<head>", "<head>" + EXTRACT));
        res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
        res.end(body);
      } catch { res.statusCode = 404; res.end(); }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function dumpDom(url) {
  return new Promise((resolve, reject) => {
    execFile(CHROME, ["--headless=new", "--disable-gpu", "--window-size=1440,900", "--virtual-time-budget=20000", `--user-data-dir=${join(tmpdir(), "lpm-prerender-chrome")}`, "--dump-dom", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
      // Headless Chrome on macOS often exits non-zero during teardown after
      // printing a complete DOM, so judge by the output, not the exit code.
      (err, stdout) => (stdout && stdout.includes("</html>") ? resolve(stdout) : reject(err || new Error("empty DOM"))));
  });
}

async function prerender(page) {
  const server = await serve(page);
  try {
    const dom = await dumpDom(`http://127.0.0.1:${server.address().port}/${page}`);
    const m = dom.match(/id="lpm-prerender-out" data-html="([^"]+)"/);
    if (!m) throw new Error(`${page}: page never rendered an <h1>`);
    return Buffer.from(m[1], "base64").toString("utf8");
  } finally {
    server.close();
  }
}

/* Outer-shell edits, applied once per page. */
const OUTER_CSS = `
    html { overflow: hidden; }
    #lpm-static { max-width: 900px; margin: 0 auto; padding: 32px 20px; color: #f4f1fb; font: 16px/1.6 -apple-system, BlinkMacSystemFont, sans-serif; }
    #lpm-static a { color: #12C8D8; }
    #lpm-static img { height: 26px; width: auto; }
  </style>`;
const NOSCRIPT_OLD = /<noscript>[\s\S]*?<\/noscript>/;
const NOSCRIPT_NEW = `<noscript>
    <style>html { overflow: auto; } body { display: block; } #__bundler_thumbnail, #__bundler_loading { display: none; }</style>
  </noscript>`;

function inject(html, block, hash) {
  if (!html.includes("#lpm-static")) {
    html = html.replace("  </style>", OUTER_CSS.replace(/^\n/, "")).replace(NOSCRIPT_OLD, NOSCRIPT_NEW);
  }
  const stamped = `${START} template=${hash} (generated by scripts/prerender-bundles.mjs; do not edit) -->\n<div id="lpm-static">\n${block}\n</div>\n${END}`;
  const s = html.indexOf(START);
  if (s >= 0) return html.slice(0, s) + stamped + html.slice(html.indexOf(END) + END.length);
  return html.replace("<body>\n", `<body>\n${stamped}\n`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const pages = process.argv.slice(2).length ? process.argv.slice(2) : BUNDLE_PAGES;
  for (const page of pages) {
    const path = join(ROOT, page);
    const html = await readFile(path, "utf8");
    const block = await prerender(page);
    const words = block.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    await writeFile(path, inject(html, block, templateHash(html)));
    console.log(`${page}: ${words} words`);
  }
}
