# LeadFlow AI

> Агентний TypeScript-пайплайн, який **збагачує B2B-ліди з їхніх сайтів** і пише **AI-персоналізовані тексти холодного аутрічу** — opener, ice-breaker, тему листа й чесну оцінку fit. CSV / Google Sheets на вході, CSV / Sheets / Resend на виході. Anthropic або Groq. **Без n8n, без Zapier — лише код.**

> [English version](./README.md)

```
 leads.csv  ──►  enrich (fetch site)  ──►  LLM (structured)  ──►  validate  ──►  CSV / Sheets / Email
                       │                         │
                       ▼                         ▼
                  data/cache/             zod schema + tool-use
                  (JSON по домену)        (Claude tool_choice, Groq response_format)
```

Це патерн «Clay / SDR lite», побудований як чистий типізований пайплайн:

- Кладеш список `company, domain, name, role, email`
- Для кожного ліда пайплайн тягне сайт, витягує невеликий структурований контекст і одним LLM-викликом пише персоналізацію
- AI **пише тільки з реального контексту** — не може вигадати раунд інвестицій, клієнтів або цифри
- Невдалі фетчі, помилки LLM, биті JSON — жодне з цього не валить батч; лід просто помічається і отримує fallback-opener
- На виході — `data/out/leads_enriched.csv` (опційно — додавання до Google Sheet, опційно — тестовий лист через Resend)

---

## Швидкий старт (офлайн, без API-ключів)

```bash
git clone https://github.com/morgunglyeb-arch/leadflow-ai
cd leadflow-ai
npm install
npm run gen:demo                       # створить data/leads.csv + data/fixtures/
npm run leads -- --mock --dry          # повний пайплайн на фікстурах, без мережі
```

Побачиш, як кожен лід збагачується з фікстури, з fallback-opener'ом якщо ключа немає. Додай `ANTHROPIC_API_KEY` або `GROQ_API_KEY` в `.env` і перезапусти — отримаєш справжню AI-персоналізацію.

---

## Швидкий старт (реальний прогон)

```bash
cp .env.example .env                   # встав ANTHROPIC_API_KEY + OUR_OFFER
npm run leads -- --input=data/leads.csv
# → data/out/leads_enriched.csv
```

---

## Чому воно так зроблено

| Проблема | Як LeadFlow її розв'язує |
|---|---|
| **Анти-галюцинації** | LLM бачить лише реальний текст з сайту ліда; system prompt забороняє вигадувати факти; тонкий контекст → `fit_score ≤ 2` |
| **Структурований вивід** | Anthropic tool-use (`tool_choice` + `input_schema`) **або** Groq `response_format: json_object`, обидва валідуються однією zod-схемою |
| **Graceful failure** | Битий fetch / не-HTML / таймаут → лід помічається `enriched:false`, батч іде далі. Помилка LLM → fallback-шаблон. |
| **Resumable** | Кеш JSON по домену (`data/cache/<domain>.json`); вже оброблені ліди (по email або домену) скіпаються без `--force` |
| **Ввічлива конкурентність** | Власний `pLimit`, щоб не задовбати сайт і не вийти за рейт-ліміт LLM |
| **Демо без секретів** | `--mock` бере `data/fixtures/<domain>.txt`, тому CI / скріншоти / «покажи як працює» — детерміновано і без мережі |
| **Перемикання провайдерів** | `LLM_PROVIDER=anthropic\|groq` змінює місце виклику; схема, промпт і fallback спільні |

---

## CLI

```
npm run leads -- [flags]

  --dry                Надрукувати рядки, не писати CSV / Sheets / лист
  --mock               Використати фікстури data/fixtures/<domain>.txt (без мережі)
  --input=PATH         Інший CSV ніж LEADS_CSV_PATH
  --limit=N            Обробити лише перші N лідів
  --concurrency=N      Перевизначити CONCURRENCY (за замовч. 5)
  --force              Ігнорувати кеш + ідемпотентність (переобробити все)
  --send-test          Надіслати перший рядок через Resend (smoke-test)
  --help, -h           Показати довідку
```

### Приклади

```bash
npm run leads -- --mock --dry           # офлайн демо для CI / скріншотів
npm run leads -- --input=my_list.csv    # реальний CSV, запис у дефолтний вихід
npm run leads -- --limit=10             # спробувати перші 10 лідів
npm run leads -- --concurrency=3        # лагідніше до LLM
npm run leads -- --force                # перезбагатити, ігноруючи кеш
```

---

## Входи

### `data/leads.csv`

```
company,domain,name,role,email
Northwind Logistics,northwindlogistics.example,Marcus Hale,VP Operations,marcus.hale@northwindlogistics.example
Lumen Health,lumenhealth.example,Priya Anand,Head of Product,priya.anand@lumenhealth.example
…
```

Обов'язкові колонки: `company`, `domain`. Усе інше — опційно, передається в AI, коли є. `linkedin` також підтримується.

### Google Sheets (замість CSV)

Постав `LEADS_SOURCE=sheets`, поклади service-account JSON в `GOOGLE_SERVICE_ACCOUNT_JSON`, вкажи `GOOGLE_SHEETS_ID` — і той самий парсер використається після підтягування рядків через Sheets API.

---

## Виходи

### `data/out/leads_enriched.csv`

```
company,domain,name,role,linkedin,email,enriched,enrichment_source,signals,ai_provider,subject,opener,icebreaker,fit_score,reason
Northwind Logistics,northwindlogistics.example,Marcus Hale,VP Operations,,marcus.hale@…,true,mock,logistics|ecommerce|b2b|careers,groq,"AI workflows for Northwind's delivery ops","Your route-planning platform that plugs directly into Shopify and BigCommerce is a clear win for SMB ecommerce brands.","Cutting last-mile costs by up to 24% for brands shipping 500-5,000 orders weekly is impressive.",4,"Northwind runs a B2B SaaS logistics solution handling 500-5k weekly orders."
…
```

**Ідемпотентність**: повторний прогін з тим самим інпутом скіпне ліди, в яких `email` або `domain` вже є у вихідному CSV. `--force` обходить це.

CSV пишеться з **UTF-8 BOM**, тому коректно відкривається в Excel/Numbers без «крякозябр» від юнікод-символів, які іноді віддає AI (напр., U+2011 non-breaking hyphen).

### Гарний HTML-перегляд (`npm run view`)

```bash
npm run leads -- --mock --force --limit=15
npm run view
open data/out/leads_enriched.html
```

Скрипт рендерить кожен лід як **картку** з email-preview (subject → opener → icebreaker → why fit), бейджем fit_score з кольоровим індикатором, виявленими сигналами як чіпсами. Підходить для скріншотів у портфоліо й перегляду в браузері без Excel/Numbers.

### Google Sheets append (опційно)

Постав `SHEETS_OUTPUT_ENABLED=true` і ті ж service-account credentials; рядки додаються в `GOOGLE_SHEETS_WRITE_RANGE`.

### Тестовий лист Resend (опційно)

`--send-test` шле один відрендерений холодний лист (subject + greeting + opener + icebreaker) першого рядка на `EMAIL_TEST_TO` — корисно як smoke-test перед тим, як віддати CSV у реальний сендер (Instantly, Smartlead, Lemlist).

---

## Конфігурація (`.env`)

| Ключ | За замовч. | Нотатки |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | або `groq` |
| `ANTHROPIC_API_KEY` | — | обов'язково при provider=anthropic |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | |
| `GROQ_API_KEY` | — | обов'язково при provider=groq |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | |
| `OUR_OFFER` | — | **важливо.** Один абзац: що продаєш, кому. AI використовує це для оцінки fit і налаштування opener. |
| `LEADS_SOURCE` | `csv` | або `sheets` |
| `LEADS_CSV_PATH` | `data/leads.csv` | |
| `ENRICH_TIMEOUT_MS` | `8000` | таймаут на запит до сайту |
| `ENRICH_USER_AGENT` | LeadFlowAI/1.0 | надсилається в outbound-fetch'ах |
| `ENRICH_CACHE_DIR` | `data/cache` | JSON-кеш по доменах |
| `CONCURRENCY` | `5` | паралельні воркери enrichment+LLM |
| `OUTPUT_CSV_PATH` | `data/out/leads_enriched.csv` | |
| `SHEETS_OUTPUT_ENABLED` | `false` | додатково писати в Google Sheet |
| `RESEND_API_KEY` / `EMAIL_FROM` / `EMAIL_TEST_TO` | — | лише для `--send-test` |

Повний шаблон: [`.env.example`](.env.example).

---

## Що AI отримує — і що отримати не може

**Вхід в модель (для кожного ліда):**
- Твоя пропозиція (`OUR_OFFER`)
- Рядок ліда (`company, domain, name?, role?`)
- Контекст з сайту: title, meta description, верхні H1/H2, body-текст обрізаний до ~4000 символів
- Список виявлених правилами сигналів (наприклад `pricing | careers | saas | b2b | ai`)

**Правила system prompt'у (примушуються кодом — схемою; промптом — за духом):**
- Використовувати тільки наданий контекст, не вигадувати факти
- Якщо контексту мало — писати чистий generic opener і ставити `fit_score ≤ 2`
- Згадувати максимум одну специфічну деталь на повідомлення
- Заборонені фрази: "I hope this finds you well", "I came across your", "love what you're doing", флатері-кліше
- `subject ≤ 60 символів`, без емодзі, без ALL CAPS
- Чесний fit-скоринг 1–5 проти твоєї пропозиції

**Схема виводу (zod-валідована; невдача → fallback):**

```ts
{
  opener: string;     // 1-2 речення, перший рядок холодного листа
  icebreaker: string; // коротке спостереження
  subject: string;    // <= 60 символів
  fit_score: 1..5;
  reason: string;     // одна лінія обґрунтування
}
```

---

## Архітектура

```
src/
  index.ts          CLI — парсинг прапорців + entrypoint
  config.ts         zod-валідація env
  types.ts          Lead, Enrichment, Personalized, OutputRow
  orchestrator.ts   runEnrichment — сам пайплайн
  sources/
    index.ts        LeadsSource interface + фабрика + нормалізатор доменів
    csv.ts          CSV-парсер (стійкий до лапок)
    sheets.ts       Google Sheets reader (JWT service account)
  enrich.ts         fetchSite, HTML→текст, signal-правила, fixture loader
  ai.ts             Claude tool-use + Groq json_object + zod + fallback
  cache.ts          per-domain JSON cache
  pLimit.ts         мініатюрний concurrency limiter
  output.ts         CSV writer, Sheets append, Resend test email
scripts/
  gen-demo.ts       seeded демо-ліди + відповідні фікстури
  view-csv.ts       HTML-перегляд у вигляді карток
data/
  leads.csv         демо-вхід (генерується)
  fixtures/         офлайн-тексти сайтів, ключовані доменом
  cache/            per-domain enrichment cache (gitignored)
  out/              CSV-вихід (gitignored)
```

Кожен крок — типізована функція, оркестратор поміщається на один екран, відмінності провайдерів живуть за однією схемою.

---

## Roadmap

- Apollo / Clearbit enricher за тим самим `Enricher`-інтерфейсом
- Per-company новини (свіжі анонси), додані в контекст LLM
- Пряма доставка через Instantly / Smartlead замість одного Resend test
- A/B варіанти opener'а на лід (n=2..3) з обмеженнями різноманітності
- Email-валідація + дедуп (catchall + role inbox)
- Per-segment перевизначення промпту (`OUR_OFFER` під ICP)

---

## Ліцензія

MIT — див. [LICENSE](LICENSE).
