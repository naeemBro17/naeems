# Naeem's Price Hub — Project Guide

This file is read automatically at the start of every session. Follow it.

---

## 1. WHO THIS PROJECT BELONGS TO

The owner is **Naeem**. He is a business owner in Bangladesh who imports authentic Australian skincare and sells it directly. He is **not a professional software engineer** — he is learning web development by building this site.

This changes how you communicate:

- Explain things in plain, simple English. Avoid jargon; when a technical term is unavoidable, explain it in one short sentence.
- Explain what you are going to do before making a major change.
- Break complex work into clear, manageable steps.
- If there are several good options, list them and recommend one, with the reason.
- Never make a major architectural or database change without explaining the consequences first.
- If something is risky, say so clearly before doing it.
- After making changes, build the project and state plainly whether it passed or failed.

He wants honest assessment, not polite reassurance. If something is genuinely weak, say so.

---

## 2. WHAT THIS PROJECT IS

A mobile-first e-commerce site for Australian skincare imports sold in Bangladesh.

- **Stack:** React 18 + TypeScript + Vite + Supabase + vite-plugin-pwa, deployed on Vercel
- **Currency:** Bangladeshi Taka (৳), BDT
- **Scale:** roughly 150 SKUs
- **Design target:** mobile phone first. Assume a mid-range Android phone on a slow connection.

**Three roles:**
1. **Public / customer** — anonymous, browses and orders
2. **Wholesaler** — signs up, requires admin approval, sees wholesale pricing
3. **Admin (Naeem)** — full product and settings management

There is **no payment gateway**. Orders are finalised by exporting a PDF and sending an order summary over WhatsApp. Do not add any payment integration unless explicitly asked.

---

## 3. RULES THAT APPLY TO EVERY SESSION

### Working style
- If you hit ambiguity or a decision point, **make your best judgment and keep going — do not stop and ask**. Only log a note in `Naeems.txt` if the assumption was significant enough that Naeem should know. Minor decisions: just decide and move on.

### Protect what works
- **Do not break any currently working feature.** This is the single most important rule.
- Do not rewrite, refactor, or delete working code that is unrelated to the task you were given.
- If a requested fix would risk existing behaviour, protect the existing behaviour and note the conflict in `Naeems.txt`.

### Database migrations — read this carefully
Migration files sitting in `supabase/migrations/` are **not automatically applied**. Naeem runs them by hand in the Supabase SQL Editor, often from his phone. This project has already lost a lot of time to migrations that existed in the repo but had never been run, causing features to silently fail.

Therefore:
- **Never assume a migration has been applied just because the file exists.** If a feature depends on a table, column, or function, verify it actually exists in the database before debugging anything else.
- When your work needs new or re-run SQL, write the migration file **and** copy the complete, paste-ready SQL into `Naeems.txt` under a heading `SQL NAEEM MUST RUN IN SUPABASE`.
- Never silently depend on schema that may not be there.

### Git
- **Never push to `main`.**
- Always create a new branch, commit with a clear message, and push that branch to GitHub.
- If the task did not specify a branch name, choose a clear one (`fix/...`, `feature/...`) and state it at the end.

### Build
- `npm run build` must pass with **zero errors** at the end of every session.
- No TypeScript `any` types.
- No pseudo-code, no placeholder comments, no `// TODO`.
- Before every commit, run `npm run build`, `npx vitest run` and `npm run test:e2e`. All must pass. Any visual/navigation fix must be verified with frame captures, not just code review.

### Session log — per-batch reports
Starting with Batch 13, each batch writes its own report to `reports/batch-N.txt` (create the `reports/` folder if it doesn't exist) — do not append to a shared `Naeems.txt` file. This keeps concurrent batch branches from colliding on one file and keeps each report short enough to read on a phone. (`Naeems.txt` at the repo root holds every batch's report through Batch 12 — leave it as historical record, do not append to it. An older file `Wahidtodolist.txt` may also exist — leave it alone too, do not delete it, do not write to it.)

Structure the report:
1. **What I did** — one short paragraph per task, in plain language a non-technical reader can follow
2. **SQL Naeem must run in Supabase** — complete paste-ready SQL, or "None needed"
3. **What I could not finish** — and why
4. **What I found along the way** — bugs, risks, or dead code you noticed but did not fix
5. **Design decisions** — what you chose and why, wherever you were given design freedom
6. **Industry-level suggestions** — see below

### Industry-level suggestions
While working, you will notice things that are not bugs and not in scope, but fall short of what a professional e-commerce site does. **Do not implement these.** Record them in section 6 of `Naeems.txt` so Naeem can decide what to schedule.

Consider: user experience and flow, visual consistency, performance and load speed, mobile usability, accessibility, SEO and discoverability, trust signals a shopper looks for before buying, conversion (things that quietly cost sales), data model and architecture, security and access control, code health, and anything a store handling real orders and real money should have but does not.

For each: what is weak now, why it matters in business terms, and rough size (small / medium / large). Highest impact first.

---

## 4. DESIGN RULES

Naeem has a clear visual direction. Follow it rather than inventing your own, except where a task explicitly grants design authority.

### Colour — the most important design rule

The brand orange is `#FF7A45`.

Orange is currently **overused across the entire site** — it appears on prices, cart buttons, save badges, stock dots, progress bars, nav tabs, primary buttons, success graphics, zone cards and more, all at once. When everything is emphasised, nothing is. The result reads cheap rather than premium.

**The rule: roughly one orange element per screen** — the single primary action the customer should take next.

- Everything else uses a neutral scale: near-black, dark gray, mid gray, light gray, white.
- **Prices are near-black and bold, not orange.**
- Secondary actions are neutral or outlined.
- Never introduce a new accent colour to replace orange. Use neutrals.

Apply this to any screen you build or redesign. Do not perform a site-wide colour change unless the task asks for one.

### Product card (grid view)

Two columns on mobile, four cards comfortably visible per screen.

**On the card:** product image (full width of the card), product name, offer price, retail price struck through, save badge, stock status, cart button.

**Not on the card:** category tag pill, brand name, SKU.

Specific requirements:
- Product name displays **in full across two lines**. Reserve two lines of height consistently so price rows align across a row even when one name is shorter. Truncate only if the name genuinely exceeds two lines.
- Retail strikethrough price and the save badge sit together **on one single line**.
- The cart button sits at the card's **bottom-right corner in its own reserved column** (grid or flex), never absolutely positioned over the text. It must be small enough that the text column is not crushed.
- Products with no discount: strikethrough and save badge both disappear cleanly, leaving no empty gap.
- **Always verify at real 2-column mobile width (roughly 160–180px per card), never in an isolated wide preview.** Layout bugs here only appear at narrow widths.

### Motion and transitions
- Animate **only** `transform` and `opacity`. Never animate `width`, `height`, `top`, or `left`.
- Duration 250–350ms with a natural easing curve, not linear.
- A reverse transition must mirror its forward transition, not be a different animation.
- Always respect `prefers-reduced-motion` — those users get an instant change or a plain fade.
- Target 60fps on a mid-range Android phone.

### Touch gestures — recurring bug class
Horizontally swipeable elements on this site have repeatedly broken vertical page scrolling by capturing touch events. Whenever you build or touch a swipeable element:

- Set `touch-action: pan-y` so the browser handles vertical panning natively.
- Make any JS drag handler **direction-aware**: only capture the gesture once horizontal movement clearly exceeds vertical (`abs(dx) > abs(dy)` and `abs(dx) > 10px`).
- **Never call `preventDefault` on `touchmove` until the gesture is confirmed horizontal.**
- After any such change, verify vertical page scroll still works with a finger resting on that element.

### General
- No emoji characters in UI. Use SVG icons.
- Mobile first. Check every layout at phone width before considering it done.
- No dead ends: every screen must have a visible way back or out.

---

## 5. THINGS THAT MUST NEVER LEAK

- **SKU is internal.** Never show it to public or customer views. Admin only (and wholesalers only if that matches how wholesale pricing is already handled).
- **Admin and wholesale areas must be hidden from anonymous visitors** by conditional rendering based on the real authenticated role from the session — never hidden with CSS, and never by obscurity alone.
- Promo code validation and usage counting happen **server-side**. Anonymous users must never be able to update `times_used` directly — it is incremented by a `SECURITY DEFINER` function at order completion.
- When a promo code fails, show one generic message ("Invalid or expired code"). Never reveal whether it expired, was exhausted, or does not exist — that lets someone probe the limits.
- Use the existing auth/role check already in the codebase. Never create a second source of truth for roles.

---

## 6. CURRENT STATE — KNOWN GAPS

So future sessions do not assume more exists than does:

- **Orders are not stored anywhere.** There is no `orders` table. An order exists only as WhatsApp text and a PDF. Adding an orders / order_items schema with price snapshots is the next major planned feature.
- **There are no customer accounts.** Customers cannot log in or see order history.
- The product grid currently lives at `/`. A future session will move it to `/shop` and put a landing page at `/`. Until that session runs, use whatever route the grid is on today — do not pre-emptively change routing.
- Delivery tracking, blog, AI assistant, and payment gateway are all future work. None exist.
