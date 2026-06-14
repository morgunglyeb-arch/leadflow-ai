# Freelancehunt — LeadFlow AI

> Українська платформа. UA-копірайт основний, EN — як bonus для англомовних замовників.

---

## Назва проєкту в портфоліо (до 100 символів)

> **LeadFlow AI — агентний TypeScript-пайплайн збагачення B2B-лідів + AI-персоналізація**

---

## Опис проєкту (повний)

**Що це.** Production-grade TypeScript-пайплайн, що бере CSV B2B-лідів і пише для кожного готовий копірайт холодного аутрічу — `opener`, `icebreaker`, тему листа і чесну оцінку fit 1–5. Без n8n, без Zapier, без «AI wrapper» обгорток.

**Як це працює.**
1. Тягне сайт компанії (timeout + UA + перевірка content-type), парсить title / meta / H1-H2 / body, обрізає до 4000 символів, виявляє сигнали за правилами (`saas | ecommerce | b2b | careers | pricing | ai | logistics | ...`).
2. Робить **один структурований LLM-виклик** (Anthropic Claude через tool-use **або** Groq через `response_format: json_object`, перемикається через env-змінну).
3. Валідує вивід однією **zod-схемою**. Будь-яке відхилення — невалідний JSON, відсутнє поле, поза-діапазонний `fit_score` — падає на безпечний fallback-шаблон.

**Ключова фішка — анти-галюцинації за конструкцією.** Модель ніколи не бачить нічого, крім тексту, який код реально витягнув із сайту. Тонкий контекст → fit_score автоматично ≤ 2. System prompt прямо забороняє вигадувати раунди, headcount, клієнтів і будь-які цифри, яких немає в наданому контексті.

**Production-форма:**
- Per-domain JSON-кеш (`data/cache/<domain>.json`) — повторні прогони не лізуть у мережу
- Ідемпотентність проти existing CSV (вже оброблені ліди скіпаються без `--force`)
- Ввічлива конкурентність через мікроскопічний власний `pLimit`
- Джерела за одним інтерфейсом: CSV, Google Sheets (JWT service account)
- Виходи: CSV з UTF-8 BOM (Excel/Numbers-safe), Google Sheets append, тестовий лист через Resend
- Офлайн `--mock` режим для CI та скріншотів (читає `data/fixtures/<domain>.txt`)
- Окремий `npm run view` рендерить збагачений CSV як тёмний HTML з картками email-preview'ів

**Стек:** TypeScript 5.6 ESM strict (з `noUncheckedIndexedAccess`) · Node 20 · Anthropic SDK з prompt caching · Groq через OpenAI SDK · zod · googleapis · Resend · native fetch · custom `pLimit` без залежностей.

**Що це демонструє як портфоліо:**
- Agentic-пайплайн з детермінованим збором даних і обмеженим LLM
- Provider-portable структурований вивід за однією схемою
- Анти-галюцинації за конструкцією, а не лише за промптом
- Стійке web-збагачення (timeout, UA, content-type, redirects, cache)
- Адаптер-патерн для джерел і збагачувачів (легко доточити Apollo / Clearbit)
- Ідемпотентний батч із `--force` як аварійним виходом
- Демо без credentials і мережі

**Лінки:**
- Репо: github.com/morgunglyeb-arch/leadflow-ai
- Case study: github.com/morgunglyeb-arch/leadflow-ai/blob/main/PORTFOLIO.uk.md
- Лендинг: morgunglyeb-arch.github.io/leadflow-ai/

---

## Заявка-шаблон на проєкти у категорії «Автоматизація / SDR / Lead Gen»

> Доброго дня!
>
> Зробив під схожу задачу open-source шаблон, який можу адаптувати під ваш ICP за 1–2 тижні: **LeadFlow AI** — TypeScript-пайплайн, що бере CSV B2B-лідів, тягне сайт кожної компанії, виявляє сигнали (saas / ecommerce / b2b / тощо) і пише персональний копірайт холодного аутрічу через один структурований LLM-виклик (Anthropic Claude або Groq, перемикання через env).
>
> Ключове: модель бачить **тільки реальний текст із сайту**, валідується через zod, є fallback-шаблон — один поганий лід не валить батч. Це не «обгортка над промптом», це справжній код, який можна показувати тех-директору.
>
> Репо + case study: github.com/morgunglyeb-arch/leadflow-ai
>
> Під ваш проєкт:
> 1. Вшию ваш `OUR_OFFER` і ICP-логіку у промпт і fit-скоринг.
> 2. Заміню/додам джерело лідів — Apollo, Clay, HubSpot або ваш Google Sheet.
> 3. Підключу sender (Instantly / Smartlead / Lemlist) замість Resend smoke-test.
> 4. Розгорну на cron (GitHub Actions або ваш VPS) із Slack-нотифікаціями.
>
> Можу зробити 15-хв loom з прогонкою коду на існуючому репо, якщо корисно. Доступний почати цього тижня. Ставка — обговорювана, від $35/год або фіксована вартість MVP від $1,500.
>
> Гліб

---

## Категорії / теги

`Програмування` → `Бекенд` → `Node.js / TypeScript`
`Програмування` → `AI / ML`
`Дані` → `Web Scraping / Парсинг`
`Маркетинг` → `Lead Generation`

Ключові слова: `TypeScript`, `Node.js`, `Claude`, `Groq`, `LLM`, `agentic`, `lead enrichment`, `cold outreach`, `Clay alternative`, `SDR automation`, `web scraping`, `zod`, `Google Sheets`, `Resend`, `Instantly`, `Smartlead`.

---

## Ціновий діапазон (для referencs у заявках)

- **Погодинна:** $35–70/год (залежно від складності)
- **Fixed MVP** (повний пайплайн під 1 ICP, 1 джерело, 1 sender): **$1,500–2,500**
- **Тестовий батч** (50 лідів через моє репо, твій ICP): **$200–300**
- **Retainer / підтримка** (місячно, з новими enricher'ами): **$800–1,500/міс**
