# LeadFlow AI — Case Study

> [English version](./PORTFOLIO.md)

**Стек:** TypeScript (Node 20, ESM, strict, `noUncheckedIndexedAccess`) · Anthropic SDK (tool-use + prompt caching) · Groq через OpenAI SDK · zod · googleapis · Resend · native fetch · власний `pLimit`.
**Інтерфейс:** CLI. **Без n8n. Без Zapier. Без "AI wrapper".**
**Репо:** `morgunglyeb-arch/leadflow-ai`

---

## Проблема

Списки холодного аутрічу вмирають у двох передбачуваних точках:

1. **Збагачення крихке.** Перший прохід скрапінгу падає на третьому биті сайті — і весь батч мертвий.
2. **Персоналізація галюцинує.** Модель вигадує Series B, лого клієнта, headcount — і один поганий opener вбиває reputation відправника на цілий домен.

LeadFlow AI — це маленький, чесний пайплайн, що лагодить обидві проблеми. Він трактує збагачення як **детерміновану data-крок**, а LLM — як **обмеженого writer'а, що бачить тільки реальний контекст**.

---

## Що воно робить

```
leads.csv  ──►  enrich (fetch site)  ──►  LLM (structured)  ──►  validate  ──►  CSV / Sheets / Email
```

- **Вхід:** company + domain (+ опційно name, role, email, linkedin) — CSV або Google Sheets
- **Для кожного ліда** (паралельно з конфігурованим лімітом конкурентності):
  - Тягне `https://<domain>` і `/about`, парсить title / meta / H1-H2 / body, обрізає до ~4000 символів
  - Виявляє фіксований набір сигналів за правилами (`pricing | saas | ecommerce | b2b | careers | …`)
  - Робить **один** структурований LLM-виклик: opener, icebreaker, subject, `fit_score 1–5`, reason
  - Валідує вивід через одну zod-схему — будь-яке відхилення → fallback-шаблон
- **Вихід:** `data/out/leads_enriched.csv`, опційно append у Google Sheets, опційно Resend test email

---

## Анти-галюцинаційний дизайн (частина, якою я пишаюся)

Модель ніколи не бачить нічого, чого код не витягнув. System prompt короткий і *змушуючий*:

> *Use ONLY the company context provided in the user message. Never invent facts, funding, headcount, customers, product names, or numbers that are not literally present. If the context is thin, write a clean generic opener and set fit_score ≤ 2.*

Далі схема примушує структуру незалежно від того, що написала модель:

```ts
const PersonalizedSchema = z.object({
  opener:     z.string().min(5).max(400),
  icebreaker: z.string().min(3).max(280),
  subject:    z.string().min(3).max(120),
  fit_score:  z.number().int().min(1).max(5),
  reason:     z.string().min(3).max(280),
});
```

Відмінності провайдерів сховані:

- **Anthropic**: `tool_choice: { type: "tool", name: "emit_personalization" }` з `input_schema`, плюс `cache_control: { type: "ephemeral" }` на system prompt — щоб повторні прогони били в кеш.
- **Groq** (`openai/gpt-oss-120b`): `response_format: { type: "json_object" }`, та сама zod-схема, той самий fallback.

Обидва шляхи сходяться на `PersonalizedSchema.parse(...)`. Усе, що не парситься — невалідний JSON, відсутнє поле, поза-діапазонний `fit_score` — падає на fallback opener. **Один лід ніколи не валить батч.**

---

## Деталі резильєнтності, що мають значення в продакшені

- **Per-domain JSON cache** (`data/cache/<domain>.json`) — повторний прогін на тому ж списку не лізе в мережу.
- **Ідемпотентність** — вихідний CSV читається на старті; ліди, що збігаються по `email` або `domain`, скіпаються без `--force`.
- **Timeout + UA + content-type guard** на кожному fetch'і — не-HTML відповіді, редіректи в login-вол, 5xx помилки — все мітиться як `enrichment_failed` без падіння всього процесу.
- **Ввічлива конкурентність** через мікроскопічний власний `pLimit` (без залежностей); за замовч. 5, конфігурується.
- **Mock mode** — `--mock` читає `data/fixtures/<domain>.txt` замість fetch'у, тому CI і демо-прогони детерміновані й офлайн.

---

## Що це демонструє як портфоліо

| Можливість | Де дивитись |
|---|---|
| Agentic-пайплайн з детермінованими даними + обмеженим LLM | `src/orchestrator.ts`, `src/ai.ts` |
| Provider-portable структурований вивід (Claude tool-use + Groq json_object) за однією схемою | `src/ai.ts` |
| Анти-галюцинації *за конструкцією*, не лише промптом | `src/ai.ts` system prompt + zod + fallback |
| Стійке web-збагачення (timeout, UA, content-type, redirects, cache) | `src/enrich.ts`, `src/cache.ts` |
| Конкурентність без залежностей | `src/pLimit.ts` |
| Адаптери джерел (CSV, Sheets) за одним інтерфейсом | `src/sources/index.ts` |
| Ідемпотентний батч з `--force` як аварійним виходом | `src/orchestrator.ts`, `src/output.ts` |
| Демо без credentials і мережі | `scripts/gen-demo.ts`, `data/fixtures/`, `--mock --dry` |

---

## Чому без n8n

n8n чудовий, коли робота — *переганяти дані між SaaS-інструментами, за які вже платиш*. Він стає не чудовим, коли робота — *обмежити LLM і втримати батч живим, коли щось одне падає*. І те, й інше простіше в коді:

- Zod-схема — один рядок; n8n-еквівалент це "Code"-нода, яка вже зламала візуальний потік.
- Конкурентність з backoff і per-domain cache — це ~30 рядків TypeScript; в n8n це два sub-workflow і черга.
- Fallback-шаблон, який модель не може обійти, тут тривіальний; в n8n це `if`-гілка з неправильним дефолтом.

Тому це свідомий "**code-first agentic workflow**" — та сама форма, що у Clay / Apollo, але підтримується як типізований модуль, а не як скріншот.

---

## Roadmap

- Apollo / Clearbit enricher за існуючим адаптер-слотом
- Per-company recent-news context (один виклик до search API, влитий у LLM input)
- A/B варіанти opener'а з обмеженнями різноманітності
- Пряма доставка в Instantly / Smartlead замість одного Resend smoke-test
- Email-валідація + фільтр role-inbox

---

**Автор:** Glyeb Morgun — [github.com/morgunglyeb-arch](https://github.com/morgunglyeb-arch)
