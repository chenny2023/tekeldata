# Edanic delivery renderer

Pages are delivered as Markdown + frontmatter under `content/` (each carries `title / description / slug / jsonld / internal_links / last_updated`).

**⚠ Action needed — your stack needs one wiring step:**
We couldn't identify your framework, so we didn't inject a renderer. These pages are delivered as portable Markdown + frontmatter under `content/` — point your build's content pipeline at them, or pull via MCP (`edanic_pull_pages`) and let your AI stitch them in.

_Too much wiring for this project? Skip all of the above and pull via **MCP** (`edanic_pull_pages`) — your AI stitches the pages into your own components (native look, in your router/sitemap).

**Verify (AI answer engines don't run JS):** after deploy, `curl -A 'GPTBot' <page-url> | grep '<a phrase from the body>'` — no output = not server-rendered.
