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
- [x] Translate `crypto-casino-proof-of-reserves` into Turkish (tr)
- [x] Translate `crypto-casino-red-flags` into Turkish (tr)
- [x] Translate `how-to-spot-a-crypto-casino-that-wont-pay` into Turkish (tr)
- [x] Translate `how-to-choose-a-crypto-casino` into Turkish (tr)
- [x] Translate `crypto-casino-withdrawal-times` into Turkish (tr)
- [x] Translate `are-crypto-casinos-legal` into Turkish (tr)
- [x] Translate `what-is-igaming` into Turkish (tr)

### Deepen the English guide set into all languages (translate an existing English guide into every active locale, one guide per run — pick the next English guide not yet in the multilingual set: crypto-casino-bonuses-explained, provably-fair-explained, crypto-casino-kyc-and-anonymity, crypto-casino-vs-online-casino, best-crypto-for-casino-deposits)
- [x] Add `crypto-casino-bonuses-explained` to the multilingual set (translate into every active locale: ja/ko/pt/es/de and any added since), and add `alternates: guideHreflang(...)` to its English registration in seo.ts
- [x] Add `provably-fair-explained` to the multilingual set (all active locales) + English alternates
- [x] Add `crypto-casino-kyc-and-anonymity` to the multilingual set (all active locales) + English alternates
- [x] Add `crypto-casino-vs-online-casino` to the multilingual set (all active locales) + English alternates

### New English data-story pages (moat content — factual, on-chain, wash-excluded, no verdicts)
- [ ] Add a "crypto casino chain migration" data story at `/data/crypto-casino-chain-migration` — where casino money is shifting between chains (net flow by chain over time), modelled on the existing data-story pages in seo.ts (visible FAQ + FAQPage + Dataset JSON-LD, linked from the /data hub and llms.txt). Only ship if the underlying data is real and ≥medium-confidence; otherwise leave unchecked and report the data gap.
  - **STATUS 2026-08-03 — still a pure time gate, but the clock had SILENTLY STOPPED and is now running again.**
    The source switch is done and correct: `snapshot.ts` writes `chain_reserve_history`
    from `chainReserveSplit()` (self-hosted `wallet_chain_balances`, see `chainreserves.ts`),
    NOT from the frozen `arkham_chain_reserves`. The Arkham-era rows were purged once
    (latched in `sync_state` key `chainreshist:source`).
    **What the 2026-08-01 note missed:** the series was not accumulating at all. At
    2026-08-01T14:27Z `startKick()` threw `SqliteError: database is locked` inside the one
    synchronous boot block in `server.ts`, which truncated the rest of the sequence — the
    daily snapshot generator (the only writer of `chain_reserve_history`), the SEO page
    rebuild and the wallet balance sweep never started, and stayed dead for ~35h while the
    process looked healthy. Fixed by fault-isolating every `startX()` (`boot()` helper in
    `server.ts`) plus a best-effort guard in `kick.ts seedRoster()`; deployed and verified
    2026-08-03. Lesson: **check `days` is actually advancing, not just `ready:false`** — a
    frozen writer and a legitimately-young series look identical from the `ready` flag alone.
    Verified on prod 2026-08-03: `GET /api/diag/chain-reserve-history` →
    `{days:2, lastDay:"2026-08-03", distinctDailyTotals:2, sourceStalled:false, ready:false}`;
    sweep freshness `rawFreshestAgeMin:0`. 2026-08-02 is a permanent one-day hole in the
    series (nothing ran); harmless for the gate.
    Nothing to do until `ready:true` (needs `days>=21` AND `distinctDailyTotals>=ceil(days/2)`,
    ~2026-08-22 at the earliest, assuming a row lands every day from here). Then build the page
    as **reserve-share drift across chains** from `chain_reserve_history`, operator set fixed to
    mapped entities, visible FAQ + FAQPage + Dataset JSON-LD, linked from the /data hub +
    llms.txt. Do NOT lower the gate to publish early — a flat/near-flat series would be a
    misleading "migration" finding.
- [x] Add a "biggest crypto casino reserve movements this week" data story (top reserve gainers/losers by absolute USD, complementing the existing % reserve-drawdown page).

<!-- Append new vetted items above this line. Keep them specific and self-contained. -->
