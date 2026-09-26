# Articles

Everything under `/blog/` and `/industries/` is generated from the Markdown
here into plain HTML, so crawlers and AI fetch tools can read it without
running JavaScript. (The rest of the site is JS bundles that show only
"Unpacking..." to a plain HTTP fetch.)

1. Add `content/blog/<slug>.md` or `content/industries/<slug>.md`. The file
   name becomes the URL: `content/industries/credit-unions.md` →
   `https://www.launchpodmedia.com/industries/credit-unions`.
2. Start it with front matter:

   ```
   ---
   title: Podcasts for credit unions
   description: One sentence. Used for the meta description and index card.
   date: 2026-09-25
   updated: 2026-10-02
   author: John Dinkel
   draft: true
   ---
   ```

   `title`, `description` and `date` are required. `author` defaults to
   LaunchPod Media. `draft: true` keeps it out of the build.
3. Run `npm run build:content` and commit the Markdown *and* the generated
   HTML. It also refreshes `sitemap.xml` and `llms.txt`. `npm test` fails if
   the generated files are out of date.
4. Once it's deployed, check it the way a crawler would:

   ```
   curl -s https://www.launchpodmedia.com/industries/credit-unions | grep -c "<p>"
   ```

   If the article text comes back in the raw response, crawlers can read it.

Preview drafts without touching the repo:
`node scripts/build-content.mjs --drafts --out /tmp/lpm-preview`.
