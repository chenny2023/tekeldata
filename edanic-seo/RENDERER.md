# Edanic delivery renderer (scaffold)

These pages are delivered as Markdown under `content/answers/`. This scaffold renders them as **native pages
on your site** — review once, then every future Edanic PR just adds Markdown here and shows up automatically.

**Next.js (App Router) — included as real files:**
- `app/answers/[...slug]/page.tsx` + `edanic-render.ts` — reads `content/answers/**/*.md`, renders each at `/answers/…`.
- App Router **auto-wraps these routes in your `app/layout.tsx`**, so header/footer/fonts/colors are already your site's.
  Body prose is styled from your design tokens (see the `<style>` in `page.tsx`).
- **Dependency-free** (only `node:fs`/`node:path`). Safe to build as-is. If you already render this content another way,
  just delete the `app/answers/` folder.

**Not on Next.js?** The Markdown + frontmatter is portable. Point your framework's content pipeline at
`content/answers/*.md` (Astro content collection, Hugo layout, Nuxt Content, etc.); each file's frontmatter carries
`title / description / slug / jsonld / internal_links / last_updated`. Or keep pulling via MCP (`edanic_pull_pages`),
where your AI stitches pages into your components directly.

**Verify SSR (AI answer engines don't run JS):** after deploy,
`curl -A 'GPTBot' <page-url> | grep '<a phrase from the body>'` — no output = not server-rendered, fix before relying on it.
