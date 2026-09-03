# opencode-plugin-perplexity

OpenCode-плагин, регистрирующий один инструмент — `perplexity_research`: поиск по Perplexity через ваш залогиненный браузер (Chrome/Thorium) и **OpenCLI Browser Bridge**.

Плагин — тонкая обёртка над внешним CLI-процессом и **не имеет собственного сетевого доступа**. Вся работа выполняется `opencli`, который через локальный демон, расширение Browser Bridge и CDP управляет вашей реальной вкладкой `perplexity.ai`.

```bash
opencli perplexity ask "<question>" --format json --output result.json
```

## Возможности

- Поиск и глубокий research (`search` / `deep_research`) в Perplexity.
- Авторизация из cookies вашего браузера — без токенов и ключей.
- Источники возвращаются в структурированном виде, с пометкой `trusted` по `allowedDomains`.
- Математические формулы извлекаются в виде чистого TeX, таблицы — в markdown.
- Каждый вызов логируется JSONL-трассой.

## Установка

### Адаптер (один раз)

Публичная OpenCLI не содержит адаптера `perplexity` (есть только аналогичный `gemini`), поэтому он поставляется в этом репозитории.

```bash
bun install
bun run adapter:install     # копирует adapter/perplexity → ~/.opencli/clis/perplexity/

# проверка
opencli list
opencli doctor
```

### Плагин

Скопируйте `src/index.ts` в `.opencode/plugins/perplexity.ts` проекта (или `~/.config/opencode/plugins/perplexity.ts` — глобально) с зависимостями:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.18.25",
    "@opencode-ai/sdk": "1.18.25",
    "zod": "4.1.8"
  }
}
```

Либо соберите и подключите как пакет:

```bash
bun run build               # -> dist/index.js
```

```json
{
  "plugin": ["file:///abs/path/to/opencode-plugin-perplexity/dist/index.js"]
}
```

## Использование

`perplexity_research` — единственный инструмент, аргументы:

| Аргумент | Тип | По умолчанию | Описание |
|---|---|---|---|
| `question` | string | — | запрос (обязателен, `min 10`, `max 4000`) |
| `allowedDomains` | string[] | — | домены для пометки `trusted` |
| `maxWaitSeconds` | number | `130` | таймаут CLI (`15–240`) |
| `requireSources` | bool | `false` | `true` → пустой `sources` вернёт ошибку модели |
| `mode` | `search \| deep_research` | `search` | режим поиска |
| `incognito` | bool | `false` | инкогнито |

Результат — `ToolResult` с преамбулой «НЕДОВЕРЕННЫЕ ДАННЫЕ», текстом ответа, списком источников и метаданными (`threadUrl`, `elapsedSeconds`, `traceId`).

## Предустановки и диагностика

Нужны: Chrome/Chromium с расширением **Browser Bridge**, демон OpenCLI и авторизованный профиль с активной сессией `perplexity.ai`.

```bash
opencli doctor                             # демон + Browser Bridge
opencli daemon restart                     # если расширение не подключилось
opencli profile list                       # авторизованные Chrome-профили
opencli perplexity auth                    # залогинены ли в Perplexity
opencli perplexity status                  # URL вкладки + состояние
```

> [!NOTE]
> Кнопка «Stop» исчезает раньше, чем ответ полностью отрисуется. Если таймаут — перезапустите браузер (kill всех процессов Thorium/Chrome и чистый запуск), это основной фикс.

## Тесты

```bash
bun test
```

## Архитектура

```
OpenCode Plugin
  └─ opencli perplexity ask "..." --format json --output tmp.json
       └─ Local daemon (port 19825) → Browser Bridge MV3 → CDP → вкладка perplexity.ai
```

Адаптер `ask` берет/открывает вкладку, вводит промпт через CDP `Input.insertText`, ждёт завершения генерации, читает ответ и источники из DOM, пишет JSON в `--output`. DOM-селекторы собраны в `adapter/perplexity/utils.js` с фолбэками — при изменении разметки Perplexity правится один файл.
