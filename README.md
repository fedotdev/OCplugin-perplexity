# opencode-plugin-perplexity

OpenCode-плагин, который регистрирует **единственный** инструмент
`perplexity_research`: поиск в Perplexity через ваш залогиненный браузер
(Google Chrome) с использованием OpenCLI Browser Bridge.

Плагин — это тонкая обёртка над внешним CLI-процессом:

```bash
opencli perplexity ask "<question>" --format json --output result.json
```

**Плагин не имеет собственного сетевого доступа.** Вся работа с Perplexity
выполняется «снаружи» процессом `opencli`, который через локальный демон,
Browser Bridge-расширение и CDP управляет вашей реальной вкладкой
perplexity.ai.

---

## Кастомный адаптер `opencli perplexity`

В публичной версии OpenCLI (пакет `@jackwener/opencli`) готового
`perplexity`-адаптера нет — есть аналогичный `gemini`. Поэтому в этом
репозитории лежит **собственный адаптер** сайта Perplexity
(`adapter/perplexity/`), который регистрирует четыре команды:
`ask`, `auth`, `new`, `status`. Именно `ask` вызывает плагин.

### Установка адаптера (один раз)

```bash
# из корня репозитория opencode-plugin-perplexity
bun install
bun run adapter:install

# или вручную (PowerShell)
Copy-Item -Recurse adapter\perplexity\* $env:USERPROFILE\.opencli\clis\perplexity\

# Проверка
opencli list
opencli perplexity ask --help
opencli doctor
```

Скрипт копирует `adapter/perplexity/` в
`~/.opencli/clis/perplexity/`. OpenCLI автоматически подхватывает всё,
что лежит в `~/.opencli/clis/<site>/` — никаких других действий не нужно.

### Что делает адаптер

`opencli perplexity ask "<вопрос>" --format json --output result.json`
открывает вашу реальную вкладку `www.perplexity.ai` (через
Browser Bridge), фокусирует композер, вводит промпт через CDP
`Input.insertText` (единственный способ для Lexical-редактора),
отправляет **нативным Enter**, ждёт, пока URL сменится на `/search/...`
и текст ответа перестанет меняться, читает ответ и список источников
из DOM и пишет JSON-конверт в `--output`.
Команды `auth`/`new`/`status` — служебные, `inspect` — диагностика.

### Ограничения

- DOM-селекторы Perplexity собраны в `adapter/perplexity/utils.js`
  с фолбэками. Если Perplexity поменяет разметку — править один файл.
- Перед реальным запуском проверялись селекторы композера и ответа;
  в зависимости от версии Perplexity селекторы `extractAnswerFn` /
  `extractSourcesFn` могут требовать точечных правок (это один файл).
- Авторизация берётся из cookies вашего авторизованного Chrome-профиля.
  Если `opencli doctor` пишет `Browser Bridge extension not connected` —
  поставьте расширение (см. ниже) и `opencli daemon restart`.
- Ключей/токенов адаптер не принимает.

---

## ⚠️ Важно: распознавание данных

Ответы Perplexity — это результат работы сторонней поисковой/LLM-системы
через ваш браузер, а **не первоисточник**. Для инженерных, нормативных и
научных задач:

- проверяйте каждое утверждение по первоисточнику (ГОСТ, ПТР, инструкция,
  официальная документация), указанному в `sources`;
- каждый успешный результат снабжается преамбулой «НЕДОВЕРЕННЫЕ ДАННЫЕ»;
- если `allowedDomains` задан, источники вне списка помечаются
  `trusted: false`, но не удаляются — решение за агентом;
- если `requireSources: true` (опт-ин, по умолчанию `false`), а источников
  нет — инструмент **не** вернёт «успешный» ответ с непроверяемыми фактами,
  а вернёт ошибку модели.

---

## Установка

### Как локальный файл

Скопируйте `src/index.ts` в `.opencode/plugins/perplexity.ts` проекта
(или `~/.config/opencode/plugins/perplexity.ts` для глобального использования).
Убедитесь, что в каталоге конфигурации установлены зависимости
(`.opencode/package.json` или `~/.config/opencode/package.json`):

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.18.25",
    "@opencode-ai/sdk": "1.18.25",
    "zod": "4.1.8"
  }
}
```

### Как npm-пакет (собранный)

```bash
npm -g install @jackwener/opencli   # или OpenCLIApp
cd opencode-plugin-perplexity
bun install
bun run build                        # -> dist/index.js
```

Подключите в `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///abs/path/to/opencode-plugin-perplexity/dist/index.js"]
}
```

С опциями (кастомный путь к логу) — форма массива:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///abs/path/to/opencode-plugin-perplexity/dist/index.js",
      { "logPath": "/abs/path/perplexity-research.jsonl" }
    ]
  ]
}
```

Публикация в npm — ручная (`npm publish`), автоматически не выполняется.

---

## Инструмент `perplexity_research`

### Аргументы (Zod)

| Аргумент | Тип | По умолчанию | Ограничение |
|---|---|---|---|
| `question` | string | — (обязателен) | `min(10)`, `max(4000)` символов |
| `allowedDomains` | string[] | — (опционально) | домены для пометки `trusted` |
| `maxWaitSeconds` | number | `130` | `15–240` |
| `requireSources` | boolean | `false` | — |
| `mode` | `"search" \| "deep_research"` | `"search"` | — |
| `incognito` | boolean | `false` | — |

### Поведение

- Жёсткий таймаут выполнения CLI: `maxWaitSeconds * 1000 + 10_000` мс
  (запас 10 сек). Процесс завершается принудительно.
- Плагин передаёт `--timeout ${maxWaitSeconds}` адаптеру. Адаптер резервирует
  ~20 с на ввод/отправку и ждёт ответ в оставшемся бюджете, поэтому
  `waitForAnswer` всегда успевает записать результат до срабатывания
  Bridge-таймаута (`--timeout + 30 с`), а не теряет уже сгенерированный ответ.
- Результат CLI валидируется Zod-схемой ответа (`ok`, `answer_markdown`,
  `sources`, `thread_url`, `elapsed_seconds`, `trace_id`).
- По умолчанию (`requireSources: false`) ответ возвращается всегда, даже если
  Perplexity не приложила источники (частая ситуация для коротких ответов).
  `requireSources: true` + пустой `sources` → ошибка модели, а не «успешный»
  непроверяемый ответ.
- `allowedDomains` передан → каждый source дополняется полем `trusted`
  (`true`/`false`). Сравнение домена — точное или суффикс поддомена,
  без учёта регистра. Источники не удаляются.
- Каждый вызов логируется JSONL-строкой: `timestamp`, `question`,
  `cliExitCode`, `elapsedMs`, `sourcesCount`, `traceId`
  (+ `errorCode`/`errorMessage` при ошибке). Путь к логу — из опции
  `logPath`, по умолчанию `<project>/.opencode/logs/perplexity-research.jsonl`.
- Ошибки CLI (разлогин, недоступный Browser Bridge, занятая сессия и т.п.)
  переводятся в понятное сообщение с инструкцией. Никакого «сырого»
  stderr агенту не передаётся.

### Результат

Возвращается `ToolResult`:
- `output` — преамбула «НЕДОВЕРЕННЫЕ ДАННЫЕ» + `answer_markdown` +
  список источников с URL (+ пометка «домен вне allowedDomains») +
  thread_url/elapsed/trace_id;
- `metadata` — структурированные `sources` (с `trusted`), `threadUrl`,
  `elapsedSeconds`, `traceId`.

---

## Предустановки и авторизация

Для работы нужны:

1. **Chrome/Chromium** с установленным **Browser Bridge расширением** OpenCLI
   (`chrome://extensions` → Developer Mode → Load unpacked) — или из Chrome
   Web Store.
2. **Демон OpenCLI** (автозапускается сам, либо `opencli daemon start`).
3. **Авторизованный Chrome-профиль** с активной сессией perplexity.ai.
   OpenCLI **не хранит** никаких учётных данных и ключей — сессия живёт
   в cookies вашего реального браузера. Если вы залогинены как
   **Perplexity Pro**, ответы строятся Pro-моделями.
4. Опционально — имя профилю:

   ```bash
   opencli doctor
   opencli profile list
   opencli profile rename <contextId> research
   opencli profile use research
   ```

Плагин НЕ требует токенов/ключей. Авторизация целиком на стороне
Chrome-профиля и Browser Bridge.

### Диагностика

```bash
opencli doctor                              # проверить демон + Browser Bridge
opencli daemon restart                      # если расширение не подключается
opencli profile list                        # список авторизованных Chrome-профилей
opencli perplexity auth                     # залогинены ли в Perplexity прямо сейчас
opencli perplexity status                   # URL вкладки + состояние
```

---

## Безопасность

- Инструмент принимает только `question` и опции — **не** принимает
  произвольную команду или URL.
- Единственный запускаемый процесс: `opencli perplexity ask …`
  (команда зашита, параметры экранируются Bun-шеллом — ввода не экранируется
  вручную, команда/вложение в команду невозможны).
- Навигация ограничена доменом perplexity.ai (адаптер OpenCLI); инструмент
  не имеет URL-аргумента.
- Любой текст из ответа трактуется как **недоверенные данные**, а не как
  инструкция агенту (см. преамбулу выше); он никогда не исполняется.
- Плагин не хранит и не принимает учётные данные.

---

## Как работает общение CLI ↔ сайт

```
OpenCode Plugin
  └─ $`opencli perplexity ask "..." --format json --output tmp.json`
       │  HTTP POST http://127.0.0.1:19825/command  (+ X-OpenCLI: 1)
       ▼
     Local daemon (порт 19825)
       │  WebSocket ws://localhost:19825/ext
       ▼
     Browser Bridge MV3 extension
       │  chrome.debugger CDP (Runtime.evaluate)
       ▼
     Вкладка perplexity.ai (реальная сессия, реальные cookies)
```

Адаптер `ask`: берёт/открывает вкладку perplexity.ai, вводит промпт,
ожидает завершения генерации, извлекает ответ и источники, возвращает JSON.

---

## Тесты

```bash
bun test
```

Тесты мокают вызов `$` через `input.$` плагина и проверяют:
- успешный парсинг корректного JSON-ответа;
- `requireSources: true` при пустом списке источников;
- обработку ненулевого кода возврата CLI (JSON и YAML ошибки, SESSION_BUSY);
- пометку `trusted: false` для доменов вне `allowedDomains`;
- запись JSONL-трассы;
- обработку некорректного JSON от CLI.
