# LeadFlow AI — SESSION_STATE

> Полное состояние проекта на 2026-06-16. Страховка на случай потери сессии.
> Читать сверху вниз: что это → архитектура → код → что сделано → что осталось → след. шаги.

---

## 1. Что это и цель

**LeadFlow AI** — автономный агентный TypeScript-проект. Сам:
1. находит B2B-лиды (малый бизнес Лондона),
2. исследует их (сайт + соцсети + отзывы),
3. пишет гипер-персонализированное холодное письмо (англ.),
4. отправляет через Gmail, делает follow-up,
5. обрабатывает ответы и учится на результатах.

Сделан по образцу проекта **PulseReport** для единообразия портфолио.
- Путь: `/Users/a1/LeadFlow-AI/`
- GitHub: `morgunglyeb-arch/leadflow-ai`
- Последний запушенный коммит: **108da06** (после него есть незакоммиченные изменения).

**Целевая аудитория (ВАЖНО):** небольшие бизнесы, которые ещё НЕ автоматизированы, но хотят быть в тренде, сэкономить деньги и время. НЕ люкс-бизнесы, у которых уже всё есть.

**Язык:** письма прospеку — на английском; «Разбор» для оператора (меня) — на русском.

---

## 2. Жёсткие правила продукта (из требований пользователя)

- Приветствие — по названию бизнеса, НИКОГДА по имени человека (`Hi {Company} team,`).
- НИКОГДА не предлагать созвон/встречу — оператор не говорит по-английски. CTA = «ответь, и я пришлю пример».
- Показывать МЕНЮ из нескольких услуг (люди не знают, что вообще можно автоматизировать).
- В письме — демо-пример («вот что получат твои клиенты»).
- Правильный канал под индустрию (не предлагать запись через Instagram стоматологам).
- Без хеджирования («скорее всего», «возможно») — конкретика, факты только с сайта.
- 50 лидов/день, агент сам решает объём; мягкий прогрев почты.
- A/B темы письма.

---

## 3. Технологии

- **Язык/рантайм:** TypeScript 5.6 ESM strict (`noUncheckedIndexedAccess`), Node 20, запуск через `tsx`, проверка типов `npm run typecheck` (`tsc --noEmit`).
- **LLM:** Anthropic SDK (Claude Sonnet 4.6, tool-use + cache_control + self-critique) — основной; Groq (`openai/gpt-oss-120b` через OpenAI SDK) и generic OpenAI-совместимый — фолбэк. Единая zod-схема `PersonalizedSchema` валидирует ВЕСЬ вывод LLM; при ошибке — шаблонный фолбэк.
- **dotenv:** грузится с `{ override: true }` — КРИТИЧНО (хост presets `ANTHROPIC_API_KEY=""`).
- **Discovery:** Serper `/search` (web), Serper `/places` + per-result `/search` для резолва домена (`MAPS_PROVIDER=serper`, т.к. Google Places API New не включён), Serper `/reviews` (`sortBy=ratingLow` — жалобы). Vibe Prospecting MCP-адаптер (чтение экспортов).
- **Enrichment:** умный краулинг (homepage → services/pricing/booking/contact/privacy, ~7 страниц), HTML→текст, детект сигналов (content/channel/ads/targeting), скрейп email + ранжирование, проверка email по MX-записи (бесплатно) + опц. ZeroBounce.
- **Vertical library** (`config/verticals.json`): по нише — money_channel, booking_culture, automations[], avg_ticket → в промпт для канально-реалистичных и экономически обоснованных питчей.
- **Кампания (Gmail):** OAuth loopback (порт 42813), threaded send + детект ответов, JSON-CRM, warmup/quality-политика, 3-письменные серии, bounce/suppression, окно отправки + jitter, классификация ответов (эвристика) + ассистент-черновик ответа, learning loop (winners → few-shot, A/B reply-rate).
- ROI-ранжирование, идемпотентность, pLimit-конкурентность, BOM в CSV.

---

## 4. Карта файлов (src/)

| Файл | Назначение |
|---|---|
| `config.ts` | zod-конфиг env. CALL_TO_ACTION (no-call), SENDER_INTRO, кампания (SENDING_ENABLED, GMAIL_*, SEND_DAILY_CAP=40, SEND_WARMUP_START=5/STEP=3, SEND_MIN_SCORE=9, FOLLOWUP_GAP_DAYS=3,7, SEND_WINDOW=9-18, SEND_JITTER_SEC=45, REPLY_ASSIST, EMAIL_VERIFY, SELF_CRITIQUE, OVERFETCH=4, REQUIRE_EMAIL, REQUIRE_AUTOMATION). |
| `types.ts` | `Personalized` {opener, icebreaker, subject, fit_score, reason, process, automation, est_benefit, brief, followup_1, followup_2, subject_b, demo, **services[]**}. `DiscoveredLead`, `OutputRow = DiscoveredLead & {...} & Partial<Personalized>`. |
| `ai.ts` | `PersonalizedSchema`, `TOOL_SCHEMA`, `buildSystemPrompt`, `buildUserMessage` (verticalFacts + reviewsText + winnersText), `personalize()` + `selfCritique()`, провайдеры, `fallbackPersonalization()`, `generateText()` (~line 487), `suggestReply()`. |
| `outreach.ts` | `greeting(company)`→"Hi {short} team,"; `assembleDraft` (greeting+intro+opener+меню услуг+демо+CTA+подпись); `assembleSequence`→{subject, initial(+opt-out), fu1, fu2}; `writeDrafts`, `draftMarkdown`. |
| `digest.ts` | `renderDigestHtml`, `leadCard`, `buildDraftPreview` (зеркалит письмо), `followupBlock`, `sendDigest`, `writeDigestFile`, `renderDigestText`. `<meta charset=utf-8>`. |
| `pipeline.ts` | `processLeads`: enrich → verify email (MX) → email-gate → review-mining (если cid) → personalize → OutputRow. `buildSkippedRow`, `finalizeOutput`, `printTable`. |
| `prospect.ts` | `runProspecting`: discover (×OVERFETCH) → идемпотентность → chunked qualify (email+automation gap+fit) → `roiScore(row)` → sort → finalize + digest. `isQualified`. |
| `discover/maps.ts` | `MapsDiscoverer`, `serperPlaces`, `resolveDomain` (требует name-token в корне домена). Ставит `lead.cid`. |
| `discover/reviews.ts` | `fetchReviewDigest(cid)` — лучший + худший отзыв, метит COMPLAINT. |
| `enrich.ts` | SIGNAL_RULES, CHANNEL_RULES (whatsapp/instagram/telegram/phone/online booking/contact_form/live_chat/google_ads/meta_ads/diy_site/multi_location), `extractEmails`, `extractInternalLinks`, `fetchSiteLive`, `mergeParsed`. |
| `verify-email.ts` | `verifyEmail` (syntax→ZeroBounce→MX), `domainHasMx` (кэш). |
| `vertical.ts` | `matchVertical`, `verticalFacts`. |
| `campaign/` | store.ts, policy.ts, gmail.ts (loopback 42813), classify.ts, learn.ts, run.ts, suppression.ts. |
| `cli-campaign.ts` | `npm run campaign` (--auth/--top-up/--dry-run/--status/--mock/--concurrency). |
| `spamlint.ts` | `spamLint` (risky если ≥2 триггера). |
| `output.ts` | CSV_COLUMNS (incl `services`), `csvEscape` (массивы join " \| ", BOM). |

**config/:** `icp.json` (London UK, 27 ниш, max_leads 50; gitignored), `icp.example.json` (committed), `verticals.json` (факты по нишам).
**docs/GMAIL_SETUP.md, deploy/com.leadflow.daily.plist, scripts/run-daily.sh, scripts/view-csv.ts, scripts/gen-demo.ts.**

---

## 5. Ключевые решения / разобранные ошибки

- CSV мохибейк → UTF-8 BOM; digest без `<meta charset>` → добавлен (кириллица починена).
- Google Places API не включён (403) → Serper /places + резолв домена.
- `ANTHROPIC_API_KEY` игнорился (хост ставит пустым) → `loadEnv({ override: true })`.
- Неверная связка компания↔домен → `resolveDomain` требует name-token в корне домена.
- Groq deprecated OOB OAuth → loopback (localhost:42813).
- Groq rate-limit (8k TPM) → ретрай по "try again in Xs"; перешли на Claude ради качества.
- spamlint regex `/\$\d/,$/` → `/\$\d/`.
- `.find(async…)` баг в верификации email → for-loop.

---

## 6. Безопасность / секреты (НЕ коммитить)

- `.env` (gitignored): GROQ_API_KEY, ANTHROPIC_API_KEY, SERPER_API_KEY, GOOGLE_PLACES_API_KEY, GMAIL_SENDER=morgun.automations@gmail.com.
- `secrets/` (gitignored): gmail_credentials.json (OAuth client, project adept-parsec-499608-m6) + gmail_token.json (живой токен). НИКОГДА не коммитить.
- `SENDING_ENABLED=false` сейчас — реальные письма НЕ отправлялись. НЕ переключать в true без явного подтверждения пользователя.
- `config/icp.json` gitignored; committed только `icp.example.json`.

**Статус Gmail:** проверен (getProfile для morgun.automations@gmail.com прошёл; dry-run кампании нашёл 15, заэнкьюил, выбрал топ-5 по ROI).

---

## 7. ФИНАЛЬНЫЙ СПИСОК — РЕАЛИЗОВАНО ✅ (коммит на ветке)

1. ✅ **Детект существующей автоматизации**: `enrich.ts` CHANNEL_RULES `has_chatbot` (DenGro/ManyChat/Landbot/Tidio/Chatbase/Voiceflow…), `has_review_tool`, `has_crm`, `has_textback` + `online_booking`/`live_chat`. `existingAutomations()` → список «уже есть» в промпт (не предлагать) и в дайджест. Понижение fit в промпте + ROI-штраф −2 за каждую.
2. ✅ **Рыночная цена**: `verticals.json` `service_price` (реальные UK-ставки) → `verticalPrice()` → `row.market_price` → блок в дайджесте «💷 Рыночная цена (тебе, не клиенту)». В промпт/письмо НЕ попадает.
3. ✅ **Перевод в дайджесте**: `translate()` в `ai.ts` → `row.email_translation` (оригинал EN в тёмном блоке + RU-перевод в `<details open>`).
4. ✅ **Ссылка на сайт**: кликабельный домен + «🔗 сайт» в карточке и в тексте.
5. ✅ **Мин. fit строго 4+**: `config.MIN_FIT=4`, использован в `prospect` и `campaign top-up`.
6. ✅ **Популярные автоматизации для сферы**: промпт больше не пишет «unclear» — берёт sector-typical автоматизации из INDUSTRY FACTS.
7. ✅ **Таргетинг малых НЕ-автоматизированных SMB**: секция ICP в промпте (избегать люкс/сетей с полной автоматизацией → fit 1-2) + ROI-штраф.
8. ✅ **Мульти-инбокс ротация**: `GMAIL_ACCOUNTS` (CSV адресов), `gmailInboxes()`, пер-инбокс токены, round-robin в `run.ts`, пер-инбокс warmup-cap (×N объём), `--auth` авторизует все инбоксы, `--status` показывает отправки по инбоксу.

### Что нужно от пользователя для мульти-инбокса (×3):
- Прописать в `.env`: `GMAIL_ACCOUNTS=morgun.automations@gmail.com,второй@gmail.com,третий@gmail.com`
- Запустить `npm run campaign -- --auth` и авторизовать 2 новые почты (первая уже авторизована, токен сохранится переиспользованно).
- Каждый инбокс греется отдельно: при старте 5/день × 3 = 15/день, растёт до 40×3=120/день.

---

## 8. Незакоммиченные изменения (в рабочем дереве сейчас)

Реализованы, но НЕ закоммичены (после 108da06): меню услуг + no-call CTA.
- `config.ts`: CALL_TO_ACTION (reply-based no-call), SENDER_INTRO.
- `types.ts`: `services: string[]` в Personalized.
- `ai.ts`: services в схеме/tool/required/fallback/JSON_KEYS_HINT; промпт «SHOW A FEW SERVICES» + «NEVER PROPOSE A CALL»; demo запрещает скобочные плейсхолдеры; opener знает что intro подставляется авто.
- `pipeline.ts`: `services` в row.
- `outreach.ts`: меню услуг в assembleDraft + демо «For example, here's what your customers would get:».
- `digest.ts`: services в buildDraftPreview.
- `output.ts`: колонка `services` + csvEscape join " \| ".

**typecheck после этих правок НЕ перезапускался.**

---

## 9. Следующие шаги (рекомендованный порядок)

1. Запустить `npm run typecheck`; починить ошибки от services-правок.
2. Закоммитить текущую партию (services + no-call) и запушить.
3. Добавить в `ai.ts` экспорт `translate(cfg, text, targetLang="Russian")` поверх `generateText`; завести в дайджест (оригинал EN + перевод RU на лид). → задача №3.
4. Детект существующей автоматизации (№1): расширить CHANNEL_RULES/SIGNAL_RULES детектом чатбота/виджета (DenGro, Intercom, Tidio, live-chat скрипты) + соцсети; пробросить в промпт как «уже есть — не предлагать»; понизить fit.
5. Рыночная цена для оператора (№2): добавить поле цены (из verticals.json avg_ticket / отдельной таблицы цен на услуги автоматизации) — только в дайджест, не в письмо.
6. Ссылка на сайт в дайджесте (№4) — простое: вывести `row.domain` как `<a href>`.
7. Поднять мин-fit до 4 (№5) в prospect.ts / config.
8. Популярные автоматизации-фолбэк для сферы (№6) — из verticals.json automations[].
9. Таргетинг на не-автоматизированные SMB (№7) — учесть детект автоматизации в ROI/qualify.
10. Мульти-инбокс ротация (№8) — самый крупный: список инбоксов, ротация в campaign/policy + gmail (по токену на аккаунт).

**Не отправлять реальные письма** (SENDING_ENABLED остаётся false) без явного подтверждения.

---

## 10. Команды

```
npm run typecheck         # tsc --noEmit
npm run prospect          # discover → enrich → personalize → digest
npm run campaign          # автономная Gmail-кампания
npm run campaign -- --auth      # OAuth loopback
npm run campaign -- --dry-run   # без отправки
npm run campaign -- --status
```
