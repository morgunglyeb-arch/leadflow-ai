# Upwork copy — LeadFlow AI

> [Українська версія нижче](#українська-версія) ↓

---

## 🇺🇸 Portfolio item — short description (50–100 chars)

> **Headline:** Agentic TypeScript pipeline for B2B lead enrichment + AI cold-outreach personalization

## Portfolio item — long description (≤ 2000 chars)

**The problem.** SDR teams blow budgets on Clay credits and still ship cold emails that hallucinate funding rounds, customers and headcount. Most "AI personalization" tools sit on top of a prompt and pray.

**What I built.** An agentic, code-first TypeScript pipeline that turns a CSV of B2B leads into ready-to-send personalized cold outreach — without n8n, without Zapier, without a black box.

For each lead it:
1. Fetches the company site (timeout · UA · content-type guard), parses title / meta / H1-H2 / body, detects rule-based signals (saas / ecommerce / b2b / careers / pricing / …).
2. Calls **one** structured LLM call (Anthropic tool-use **or** Groq json_object, swappable via env var) to write `opener`, `icebreaker`, `subject`, honest `fit_score 1–5`, and `reason`.
3. Validates against a single zod schema. Any deviation → safe fallback template. **One bad lead never drops the batch.**

**Anti-hallucination by construction**, not by promise: the LLM only sees text the code actually scraped from their site. Thin context → fit_score automatically capped at 2.

**Production-shaped:**
- Per-domain JSON cache → repeat runs touch no network
- Idempotent against an existing output CSV (skip already-processed without `--force`)
- Polite concurrency via a tiny custom `pLimit`
- Sources: CSV or Google Sheets behind one `LeadsSource` interface
- Outputs: CSV with UTF-8 BOM (Excel/Numbers safe), Sheets append, Resend test email
- Offline `--mock` mode reads `data/fixtures/<domain>.txt` so CI + screenshots reproduce deterministically

**Stack:** TypeScript 5.6 (ESM, strict, `noUncheckedIndexedAccess`), Node 20, Anthropic SDK with prompt caching, Groq via OpenAI SDK, zod, googleapis, Resend, native fetch.

**Repo:** github.com/morgunglyeb-arch/leadflow-ai
**Case study + screenshots:** morgunglyeb-arch.github.io/leadflow-ai/

---

## Cover-letter / proposal template (paste into Upwork bids)

> Hi {client_name} —
>
> I just built and open-sourced something almost identical to what you're describing: **LeadFlow AI** — an agentic TypeScript pipeline that takes a CSV of B2B leads, scrapes each company site, and writes personalized cold-outreach copy through one structured LLM call (Anthropic or Groq, switchable). Anti-hallucination by construction: the model only sees text the code actually pulled, validated by zod, with a fallback template that one bad lead can never use to kill a batch.
>
> Repo + 1-page case study: github.com/morgunglyeb-arch/leadflow-ai
> Live landing: morgunglyeb-arch.github.io/leadflow-ai/
>
> For your project I'd:
> 1. Plug your ICP / offer text into the prompt + fit-scoring logic.
> 2. Swap the CSV source for your Apollo / Clay / HubSpot export (or pull directly via their API).
> 3. Wire the output into your sender of choice (Instantly, Smartlead, Lemlist) instead of the Resend smoke-test I ship with.
> 4. Add the signals + enrichment fields you actually use to qualify.
>
> Happy to do a 15-min loom walking through the code on the repo if useful. Available to start this week.
>
> — Glyeb

---

## Skills / tags

`TypeScript` · `Node.js` · `Anthropic Claude` · `Groq` · `LLM` · `Prompt Engineering` · `Agentic Workflows` · `Lead Enrichment` · `Cold Outreach` · `Sales Automation` · `Web Scraping` · `zod` · `Google Sheets API` · `Resend` · `Clay alternative` · `SDR automation`

---

## Pricing positioning

- **Fixed-price MVP** (full pipeline tuned to client's ICP, 1 source, 1 output): **$1,500–2,500**
- **Hourly customization** on top of repo: **$70/hr**
- **Retainer** (monthly maintenance + new enrichers/signals): **$1,000–1,800/mo**

---

## Українська версія

### Опис портфоліо — коротко (50–100 символів)

> **Заголовок:** Агентний TypeScript-пайплайн збагачення B2B-лідів + AI-персоналізація холодного аутрічу

### Опис портфоліо — повний (≤ 2000 символів)

**Проблема.** SDR-команди палять бюджети на Clay-кредити й усе одно шлють холодні листи, що галюцинують раунди інвестицій, клієнтів і headcount. Більшість "AI-персоналізації" — це промпт + надія, що пощастить.

**Що я зробив.** Агентний, code-first TypeScript-пайплайн, що перетворює CSV B2B-лідів на готові до відправки персональні холодні листи — без n8n, без Zapier, без чорної скриньки.

Для кожного ліда він:
1. Тягне сайт компанії (timeout · UA · content-type guard), парсить title / meta / H1-H2 / body, виявляє сигнали за правилами (saas / ecommerce / b2b / careers / pricing / …).
2. Робить **один** структурований LLM-виклик (Anthropic tool-use **або** Groq json_object, перемикання через env-змінну) щоб написати `opener`, `icebreaker`, `subject`, чесний `fit_score 1–5` та `reason`.
3. Валідує однією zod-схемою. Будь-яке відхилення → безпечний fallback. **Один поганий лід ніколи не валить батч.**

**Анти-галюцинації за конструкцією**, не за обіцянкою: модель бачить лише текст, який код реально витягнув із сайту. Тонкий контекст → fit_score автоматично ≤ 2.

**Форма продакшену:**
- Per-domain JSON-кеш → повторні прогони не лізуть у мережу
- Ідемпотентність проти існуючого CSV (скіпає вже оброблених без `--force`)
- Ввічлива конкурентність через мікроскопічний власний `pLimit`
- Джерела: CSV або Google Sheets за одним `LeadsSource`-інтерфейсом
- Виходи: CSV з UTF-8 BOM (Excel/Numbers-safe), Sheets append, Resend test email
- Офлайн `--mock` режим читає `data/fixtures/<domain>.txt` — CI та скріншоти відтворюються детерміновано

**Стек:** TypeScript 5.6 (ESM, strict, `noUncheckedIndexedAccess`), Node 20, Anthropic SDK з prompt caching, Groq через OpenAI SDK, zod, googleapis, Resend, native fetch.

**Репо:** github.com/morgunglyeb-arch/leadflow-ai
**Case study + скріншоти:** morgunglyeb-arch.github.io/leadflow-ai/

### Шаблон cover-letter / proposal

> Привіт, {client_name} —
>
> Я щойно зібрав і виклав в open source майже те, що ви описуєте: **LeadFlow AI** — агентний TypeScript-пайплайн, що бере CSV B2B-лідів, скрапить сайт кожної компанії та пише персональний cold-outreach копірайт через один структурований LLM-виклик (Anthropic або Groq, перемикається). Анти-галюцинації за конструкцією: модель бачить тільки текст, який код реально витягнув, валідується через zod, з fallback-шаблоном, через який один поганий лід не вб'є батч.
>
> Репо + case study на одну сторінку: github.com/morgunglyeb-arch/leadflow-ai
> Лендинг: morgunglyeb-arch.github.io/leadflow-ai/
>
> Під ваш проєкт я б:
> 1. Вшив ваш ICP / offer-текст у промпт і логіку fit-скорингу.
> 2. Замінив CSV-джерело на ваш експорт з Apollo / Clay / HubSpot (або тягнув напряму через їхнє API).
> 3. Підключив вивід у ваш sender (Instantly, Smartlead, Lemlist) замість Resend smoke-test, який є в репо.
> 4. Додав сигнали та поля збагачення, якими ви реально кваліфікуєте.
>
> Готовий зробити 15-хв loom з прогонкою коду в репо, якщо корисно. Доступний почати цього тижня.
>
> — Гліб

### Скіли / теги

`TypeScript` · `Node.js` · `Anthropic Claude` · `Groq` · `LLM` · `Prompt Engineering` · `Agentic Workflows` · `Збагачення лідів` · `Cold Outreach` · `Sales Automation` · `Web Scraping` · `zod` · `Google Sheets API` · `Resend` · `Clay alternative` · `SDR automation`

### Цінова позиція

- **Fixed-price MVP** (повний пайплайн під ICP клієнта, 1 джерело, 1 вихід): **$1,500–2,500**
- **Hourly customization** поверх репо: **$70/год**
- **Retainer** (місячна підтримка + нові enricher'и/сигнали): **$1,000–1,800/міс**
