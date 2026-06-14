# Fiverr gig copy — LeadFlow AI

> [Українська версія нижче](#українська-версія) ↓

---

## 🇺🇸 Gig title (80 chars max)

> **I will build an AI cold outreach pipeline that enriches your B2B leads from their sites**

Alt versions to A/B:
- *I will build a Clay alternative in TypeScript that writes personalized cold emails*
- *I will build an anti-hallucination lead enrichment + AI personalization pipeline*

---

## Gig subtitle / search tags

`agentic workflow` · `lead enrichment` · `cold email personalization` · `Clay alternative` · `Apollo enrichment` · `TypeScript` · `Claude` · `Groq` · `SDR automation`

---

## Gig description

**Stop sending cold emails that hallucinate funding rounds and headcount.**

I'll build (and customize) a production-grade TypeScript pipeline that takes your CSV of B2B leads and outputs personalized cold-outreach copy — opener, ice-breaker, subject line, and an honest fit score 1–5 — for each lead.

**What you get:**
- A code-first agentic pipeline you fully own (no n8n, no Zapier, no SaaS lock-in)
- AI personalization that **only uses real text scraped from each lead's website** — anti-hallucination by construction, not by prompt promise
- Per-domain JSON cache so reruns are free
- Idempotent batches: already-processed leads are skipped
- Anthropic Claude or Groq, switchable via env var
- CSV with UTF-8 BOM (opens cleanly in Excel/Numbers) + optional Google Sheets append + optional test email via Resend
- A polished HTML viewer for your enriched leads (dark cards with email previews)
- Open-source base I built and maintain: **github.com/morgunglyeb-arch/leadflow-ai**

**This is a real piece of software** — TypeScript 5.6 strict mode, ESM, zod-validated, with fallback templates so one bad lead never drops the batch. Already documented case study at morgunglyeb-arch.github.io/leadflow-ai/.

**Send me:** your ICP / offer paragraph, a sample CSV of 5-10 leads, and what sender you use downstream (Instantly / Smartlead / Lemlist / Resend / custom). I'll deliver a working pipeline tuned to your ICP.

---

## Three-package structure

### 🥉 BASIC — $250 · 3 days · 1 revision
**Personalization on your leads, my repo**
- I run **my open-source LeadFlow AI** against your CSV (up to 50 leads) with your `OUR_OFFER` paragraph plugged in
- Output: enriched CSV ready for your sender + 1 HTML preview
- Source code link to the public repo so you can re-run any time
- *Best for:* trying the workflow before committing to a custom build

### 🥈 STANDARD — $750 · 7 days · 2 revisions
**Customized fork for your ICP**
- Forked repo customized to your stack: your signals, your fit-scoring logic, your prompt tuned to your ICP
- One source adapter (Apollo / Clay export / HubSpot / Google Sheets)
- One output adapter beyond CSV (Sheets / Webhook / Instantly upload format)
- Up to 500-lead test batch, delivered as CSV + HTML
- *Best for:* SDR teams running steady weekly batches

### 🥇 PREMIUM — $1,800 · 14 days · 3 revisions
**Production deployment**
- Everything in STANDARD
- Deployed on a scheduled runner (GitHub Actions or your own VPS) with cron
- Sender integration: direct API upload to Instantly / Smartlead / Lemlist
- Slack notification on batch completion + low-fit-score alerts
- 30-day post-launch support: bug fixes, prompt tweaks, schema additions
- *Best for:* teams running >2k leads/month and want zero ongoing manual work

---

## Add-ons (à la carte)

| Add-on | Price | Delivery |
|---|---|---|
| Apollo / Clearbit enricher adapter | +$300 | +3 days |
| Per-company news enrichment (search API) | +$250 | +3 days |
| A/B opener variants per lead (n=2..3) | +$200 | +2 days |
| Email validation + role-inbox filter | +$150 | +2 days |
| Russian / Ukrainian language output | +$100 | +1 day |
| Custom HTML report layout (your branding) | +$200 | +2 days |

---

## FAQ for the gig description

**Q: Why not just use Clay?**
A: Clay is great if you don't mind paying $400+/mo and being locked in. This is your own code, in your own GitHub, that you can extend forever. Plus you can swap providers (Claude / Groq / others) without re-buying anything.

**Q: How is this different from "I'll give you an n8n template"?**
A: This is real TypeScript code with zod validation, structured outputs, retry logic, and a proper test fixture mode. n8n templates collapse the moment one source breaks.

**Q: What if a lead's site is down?**
A: The pipeline marks the lead as `enrichment_failed`, falls back to a clean generic opener with a low fit_score, and keeps processing the rest. One bad site never drops the batch.

**Q: Do you guarantee deliverability?**
A: I guarantee technically correct, fact-grounded copy. Inbox placement depends on your sender, warm-up, domain reputation — that's outside my scope.

---

## Українська версія

### Назва gig (80 символів max)

> **Зберу AI-пайплайн холодного аутрічу зі збагаченням B2B-лідів з їхніх сайтів**

A/B-варіанти:
- *Зберу Clay-альтернативу на TypeScript, що пише персональні холодні листи*
- *Зберу пайплайн збагачення лідів + AI-персоналізації без галюцинацій*

### Підзаголовок / пошукові теги

`agentic workflow` · `збагачення лідів` · `персоналізація холодних листів` · `Clay alternative` · `Apollo enrichment` · `TypeScript` · `Claude` · `Groq` · `SDR automation`

### Опис gig

**Перестань слати холодні листи, які вигадують раунди та headcount.**

Зберу (і налаштую під тебе) production-рівня TypeScript-пайплайн, що бере твій CSV B2B-лідів і видає персоналізований copy холодного аутрічу — opener, ice-breaker, тему листа і чесну оцінку fit 1–5 — на кожен лід.

**Що ти отримаєш:**
- Code-first agentic-пайплайн, яким повністю володієш (без n8n, без Zapier, без SaaS-замка)
- AI-персоналізація, що **використовує тільки реальний текст із сайту ліда** — анти-галюцинації за конструкцією, не за обіцянкою промпта
- Per-domain JSON-кеш — повторні прогони безкоштовні
- Ідемпотентні батчі: вже оброблені ліди скіпаються
- Anthropic Claude або Groq, перемикання через env-змінну
- CSV з UTF-8 BOM (відкривається в Excel/Numbers без проблем) + опційно Google Sheets + опційно тестовий лист через Resend
- HTML-перегляд збагачених лідів у вигляді карток
- Open-source база, яку я зробив і підтримую: **github.com/morgunglyeb-arch/leadflow-ai**

**Це справжній шматок ПЗ** — TypeScript 5.6 strict, ESM, zod-валідація, fallback-шаблони, тому один поганий лід ніколи не валить батч. Case study: morgunglyeb-arch.github.io/leadflow-ai/.

**Надішли мені:** твій ICP / абзац про оффер, sample CSV на 5-10 лідів, і який sender використовуєш далі (Instantly / Smartlead / Lemlist / Resend / custom). Поверну робочий пайплайн під твій ICP.

### Три пакети

#### 🥉 BASIC — $250 · 3 дні · 1 ревізія
**Персоналізація твоїх лідів через моє репо**
- Прогоняю **мій open-source LeadFlow AI** на твоєму CSV (до 50 лідів) з вшитим твоїм `OUR_OFFER`
- Вихід: збагачений CSV для твого sender'а + 1 HTML-превʼю
- Лінк на публічне репо — можеш перезапускати скільки завгодно
- *Для кого:* спробувати воркфлоу перед замовленням кастомного білда

#### 🥈 STANDARD — $750 · 7 днів · 2 ревізії
**Кастомний форк під твій ICP**
- Форкнутий репо під твій стек: твої сигнали, твоя логіка fit-скорингу, промпт під твій ICP
- Один source-адаптер (Apollo / Clay export / HubSpot / Google Sheets)
- Один output-адаптер крім CSV (Sheets / Webhook / Instantly upload format)
- Тестовий батч до 500 лідів, віддаю CSV + HTML
- *Для кого:* SDR-команди з регулярними тижневими батчами

#### 🥇 PREMIUM — $1,800 · 14 днів · 3 ревізії
**Production-розгортання**
- Усе зі STANDARD
- Розгортаю на scheduled runner (GitHub Actions або твій VPS) з cron
- Інтеграція з sender'ом: пряма API-аплоадка в Instantly / Smartlead / Lemlist
- Slack-нотифікація по завершенні батчу + alert'и на низькі fit-score
- 30 днів пост-лонч підтримки: баг-фікси, тюнінг промптів, нові поля схеми
- *Для кого:* команди >2k лідів/міс, які хочуть нульову ручну роботу

### Доплати (à la carte)

| Доплата | Ціна | Термін |
|---|---|---|
| Apollo / Clearbit enricher | +$300 | +3 дні |
| Per-company новинне збагачення (search API) | +$250 | +3 дні |
| A/B варіанти opener'а (n=2..3) | +$200 | +2 дні |
| Email-валідація + фільтр role-inbox | +$150 | +2 дні |
| Російський / український вивід | +$100 | +1 день |
| Кастомний HTML-репорт під твій бренд | +$200 | +2 дні |

### FAQ для gig

**Q: Чому не Clay?**
A: Clay — окей, якщо не проти платити $400+/міс і бути в локу. Тут — твій код, у твоєму GitHub, який можна розширювати безкінечно. Плюс можна перемикати провайдерів (Claude / Groq / інші) без повторної покупки.

**Q: Чим це краще за "дам n8n-шаблон"?**
A: Це реальний TypeScript-код із zod-валідацією, структурованими виводами, retry-логікою і нормальним fixture-режимом. n8n-шаблони падають у першому місці, де щось пішло не так.

**Q: А якщо сайт ліда лежить?**
A: Пайплайн мітить лід як `enrichment_failed`, падає на чистий generic opener з низьким fit_score і йде далі. Один битий сайт ніколи не валить батч.

**Q: Гарантуєш доставку у inbox?**
A: Гарантую технічно коректний, фактично обґрунтований copy. Inbox placement залежить від твого sender'а, warm-up'у, доменної репутації — це поза моїм скоупом.
