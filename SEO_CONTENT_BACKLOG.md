# SEO / GEO Content Backlog

Ordered queue of **vetted, self-contained** content tasks. The `daily-seo-content`
scheduled routine executes **exactly one** unchecked (`[ ]`) item per run, top-to-bottom,
then checks it off. Never invent new thin content — if every item is checked, do nothing
and report "backlog empty".

## How each item is executed
- Guide translations: read the English source guide in `server/src/seo.ts` (search
  `path: '/guide/<slug>'`), then add a `<lang>:` block to that slug's entry in
  `server/src/i18n-guides.ts`, placed after the existing last-language block. Match the
  existing structure exactly (`h1`, `title`, `description`, `intro`, `sections[]`,
  `faqs[]`, `related`). Keep every internal link href identical to the English source;
  translate only visible text. Preserve the answer-first, neutral, no-verdict voice and
  all disclaimers (18+/responsible-gambling). Do NOT hardcode volatile numbers.
- Adding a new language: first add its `LocaleCfg` to `I18N_LOCALES` and a
  `GUIDE_HUB_I18N` entry (both in `i18n-guides.ts`), then translate at least the first
  guide in the same run so the language never launches empty (which would dangle hreflang).
- Registration/hreflang/sitemap are automatic — no `seo.ts` changes needed for
  translations. New English guides also need `alternates: guideHreflang('<slug>')` on the
  English registration in `seo.ts`.

## Per-run checklist (the routine must do all of these)
1. `npx tsc -b` must exit 0 before deploying.
2. Commit with a clear message, `git push origin master`, then `railway up --detach`.
3. After ~4–5 min, verify the new page(s) live with a retry fetch (proxy returns false
   000 — retry): expect HTTP 200, `<html lang=...>` correct, `robots ... index`,
   the right number of `hreflang=` tags, and `"FAQPage"` present.
4. Only check the item off (`[x]`) after verification passes. If it fails, leave it
   unchecked and report what broke.

---

## Queue

### German (de) — finish the 10-guide set (locale + hub + guides 1–2 already live)
- [x] Translate `how-to-verify-a-crypto-casino` into German (de)
- [x] Translate `crypto-casino-proof-of-reserves` into German (de)
- [x] Translate `crypto-casino-red-flags` into German (de)
- [x] Translate `how-to-spot-a-crypto-casino-that-wont-pay` into German (de)
- [x] Translate `how-to-choose-a-crypto-casino` into German (de)
- [x] Translate `crypto-casino-withdrawal-times` into German (de)
- [x] Translate `are-crypto-casinos-legal` into German (de)
- [x] Translate `what-is-igaming` into German (de)

### Turkish (tr) — 6th language (huge crypto-gambling grey-market demand)
- [x] Add Turkish (tr) locale + GUIDE_HUB_I18N entry, and translate `what-is-a-crypto-casino` into tr (launch non-empty)
- [x] Translate `are-crypto-casinos-safe` into Turkish (tr)
- [x] Translate `how-to-verify-a-crypto-casino` into Turkish (tr)
- [ ] Translate `crypto-casino-proof-of-reserves` into Turkish (tr)
- [ ] Translate `crypto-casino-red-flags` into Turkish (tr)
- [ ] Translate `how-to-spot-a-crypto-casino-that-wont-pay` into Turkish (tr)
- [ ] Translate `how-to-choose-a-crypto-casino` into Turkish (tr)
- [ ] Translate `crypto-casino-withdrawal-times` into Turkish (tr)
- [ ] Translate `are-crypto-casinos-legal` into Turkish (tr)
- [ ] Translate `what-is-igaming` into Turkish (tr)

### Deepen the English guide set into all languages (translate an existing English guide into every active locale, one guide per run — pick the next English guide not yet in the multilingual set: crypto-casino-bonuses-explained, provably-fair-explained, crypto-casino-kyc-and-anonymity, crypto-casino-vs-online-casino, best-crypto-for-casino-deposits)
- [ ] Add `crypto-casino-bonuses-explained` to the multilingual set (translate into every active locale: ja/ko/pt/es/de and any added since), and add `alternates: guideHreflang(...)` to its English registration in seo.ts
- [ ] Add `provably-fair-explained` to the multilingual set (all active locales) + English alternates
- [ ] Add `crypto-casino-kyc-and-anonymity` to the multilingual set (all active locales) + English alternates
- [ ] Add `crypto-casino-vs-online-casino` to the multilingual set (all active locales) + English alternates

### New English data-story pages (moat content — factual, on-chain, wash-excluded, no verdicts)
- [ ] Add a "crypto casino chain migration" data story at `/data/crypto-casino-chain-migration` — where casino money is shifting between chains (net flow by chain over time), modelled on the existing data-story pages in seo.ts (visible FAQ + FAQPage + Dataset JSON-LD, linked from the /data hub and llms.txt). Only ship if the underlying data is real and ≥medium-confidence; otherwise leave unchecked and report the data gap.
- [ ] Add a "biggest crypto casino reserve movements this week" data story (top reserve gainers/losers by absolute USD, complementing the existing % reserve-drawdown page).

<!-- Append new vetted items above this line. Keep them specific and self-contained. -->
