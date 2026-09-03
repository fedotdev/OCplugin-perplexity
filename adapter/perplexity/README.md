# adapter/perplexity

Кастомный адаптер сайта **Perplexity.ai** для OpenCLI.

Кладётся в `~/.opencli/clis/perplexity/` (user CLIs dir), после чего
`opencli list` показывает сайт `perplexity` с командами `ask`, `auth`,
`new`, `status`.

## Установка

```bash
# Из корня репозитория opencode-plugin-perplexity
bun run adapter:install

# Эквивалент вручную (Windows PowerShell)
Copy-Item -Recurse adapter\perplexity\* $env:USERPROFILE\.opencli\clis\perplexity\

# Проверка
opencli list
opencli perplexity ask --help
```

## Команды

### `opencli perplexity ask "<вопрос>"`

Отправляет промпт в Perplexity через ваш авторизованный Chrome-профиль
(через OpenCLI Browser Bridge) и возвращает JSON-конверт с ответом и
источниками. Именно эту команду вызывает плагин `perplexity_research`.

| Флаг | Описание | По умолчанию |
|---|---|---|
| `--output <file>` | Записать JSON-конверт в файл (если не задан, печатает в stdout) | — |
| `--timeout <sec>` | Макс. секунд ожидания ответа. Адаптер резервирует ~20 с на ввод/отправку и ждёт ответ в оставшемся бюджете, чтобы успеть записать результат до Bridge-лимита (`--timeout + 30`). | 90 |
| `--requireSources` | Падать, если Perplexity не вернул источники | true |
| `--new` | Начать новый тред перед отправкой | false |
| `--mode <search\|deep_research>` | Режим композера Perplexity | search |
| `--incognito` | Включить встроенный инкогнито-режим Perplexity | false |

### Режимы и инкогнито

`--mode` и `--incognito` управляют переключателями в композере Perplexity
(кнопки «Поиск», режим Deep Research, «щит» инкогнито). Они **не обязаны
существовать на каждом аккаунте/профиле**: если контроль не найден, адаптер
возвращает структурированную ошибку (`MODE_UNAVAILABLE` /
`INCOGNITO_UNAVAILABLE`) вместо того, чтобы молча отправить вопрос в
неправильном режиме. Если у вас аккаунт без Deep Research (например, модель
Claude) или без инкогнито — `ask` продолжит работать в обычном режиме
поиска.

Формат JSON-конверта (тот же, что ждёт `opencode-plugin-perplexity`):

```json
{
  "ok": true,
  "trace_id": "uuid",
  "question": "...",
  "answer_markdown": "...",
  "sources": [
    { "title": "...", "url": "https://...", "accessed_at": "ISO" }
  ],
  "thread_url": "https://www.perplexity.ai/...",
  "elapsed_seconds": 12.3
}
```

При ошибке:

```json
{
  "ok": false,
  "trace_id": "uuid",
  "error_code": "AUTH_REQUIRED | BROWSER_CONNECT | SESSION_BUSY | TIMEOUT | COMPOSE_FAILED | NO_SOURCES",
  "error_message": "...",
  "elapsed_seconds": 1.2
}
```

`error_code` маппится плагином в понятное русскоязычное сообщение.

### `opencli perplexity auth`

Проверяет, залогинен ли текущий Chrome-профиль в Perplexity
(открывает главную и смотрит, нет ли login wall).

### `opencli perplexity new`

Открывает новый тред (то же, что `ask --new` без промпта).

### `opencli perplexity status`

Сообщает URL текущей вкладки и залогинен ли профиль.

## Как это работает

Адаптер ходит в реальную вкладку `www.perplexity.ai` через OpenCLI
Browser Bridge (CDP):

1. фокусирует композер (Lexical `contenteditable`) реальным кликом;
2. вводит промпт через **CDP `Input.insertText`** (`page.nativeType`) —
   единственный способ, который воспринимает modern contenteditable-фреймворки
   (execCommand и `dispatchEvent` Lexical игнорирует);
3. отправляет **нативным Enter** (`page.nativeKeyPress`), который Perplexity
   использует по умолчанию для нового треда (следствие: не полагается на
   клик по кнопке отправки — он на home-странице вообще не появляется);
4. ждёт, пока URL сменится на `/search/...` и текст ответа перестанет
   меняться (кнопка «Stop» исчезает);
5. читает ответ и список источников из DOM.

DOM-селекторы собраны в `utils.js` с фолбэками. Если Perplexity поменяет
разметку/поведение — править один файл: функции `findComposer`,
`typePrompt`, `submitPrompt`, `extractAnswerFn`, `extractSourcesFn`.

## Чего адаптер НЕ делает

- Не хранит и не принимает API-ключей. Авторизация — cookies вашего
  реального Chrome-профиля.
- Не делает произвольной навигации вне `www.perplexity.ai`.
- Не вызывает другие команды OpenCLI.
- Не публикуется в npm — это локальный user-CLI, кладётся в
  `~/.opencli/clis/perplexity/`.
