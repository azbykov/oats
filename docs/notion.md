# Интеграция с Notion

Как Oats сохраняет заметки в Notion. Код: `src/main/integrations.ts`, `src/main/notion.ts`, вход — `authorizeNotion` в
`src/main/oauth.ts`, на сайте — Notion-маршруты в `oats-site/src/worker.ts`.

## Что видит пользователь

1. **Settings → Integrations → Connect Notion.** Открывается браузер со страницей доступа Notion. Там можно
   выбрать «Use a template» (Notion скопирует к себе страницу «Oats Notes» с базой) или отдать доступ к своим
   страницам.
2. Браузер возвращает в Oats; в настройках — воркспейс с иконкой и строка «Notes go to *Oats Notes*». Если базу
   найти не удалось, Oats просит выбрать страницу и создаёт базу там (**Create database**). **Change** — создать
   базу на другой странице.
3. В заметке, в меню **⋯**, — **Save to Notion**. Уходит то, что сейчас открыто на экране (тот же текст, что у Copy
   и Export): «My notes» или открытая панель. В шапке на несколько секунд появляется «Saved to Notion» (клик открывает
   страницу).
4. Повторное сохранение той же заметки обновляет её страницу: пункт меню называется **Update in Notion**, рядом —
   **Open in Notion**. У заметки одна страница: сохранённая другая панель заменяет текст страницы.
5. **Disconnect** забывает токен в Oats. Отозвать доступ у самого Notion можно только в Notion
   (Settings → Connections) — об этом сказано в подсказке раздела.

## Как это у Granola (для сравнения)

Разобрано по Granola 7.668.3 (app.asar). Всё делает их сервер: клиент вызывает `get-notion-integration`
(`{isConnected, canIntegrate, isBlocked, authUrl, integrations: {…: {workspace_name, workspace_icon}}}`), открывает
`authUrl` в браузере и опрашивает тот же эндпоинт каждые 2 с в течение 2 минут, пока не придёт `isConnected`.
Сохранение — `save-to-notion {document_id}`, текст в блоки Notion переводит сервер. Подключение — через шаблон:
Notion копирует страницу с базой в Private pages пользователя.

У Oats нет сервера с заметками, поэтому то же самое делает main-процесс: токен хранится локально, запросы к
`api.notion.com` идут из приложения, а oats-site только участвует во входе (секрет клиента живёт там). Опрос не
нужен — ответ возвращается в loopback-listener, как при входе через Google.

## Вход: сайт обменивает код сам

```
Oats main                         oats-site                       Notion
─────────                         ─────────                       ──────
authorizeNotion()
  listener 127.0.0.1:47821
  state = "<port>.<random>", одноразовая пара ключей ECDH P-256
  open → /auth/notion/start?state&key
                                  302 → /v1/oauth/authorize?client_id&redirect_uri&response_type=code&owner=user
                                        &state=<state>.<key>
                                                                  страница доступа: шаблон или свои страницы
                                  /auth/callback?code&state  ◄──
                                  POST /v1/oauth/token (Basic client_id:secret, JSON) ──►
                                  ◄── access_token, refresh_token, bot_id, workspace_*, duplicated_template_id
                                  токены → seal(key), state — associated data
  /oauth/callback?state&sealed ◄─ 302 на 127.0.0.1:<port>
  openSealed(privateKey) → токены
```

**Почему не PKCE.** Документация Notion про PKCE ничего не говорит, а без него код, отданный приложению, мог бы
обменять кто угодно, кто его увидел (код остаётся в истории браузера): начать свой вход и прийти на `/token` со
своим `code_verifier`. Проверка PKCE на самом сайте этого не закрывает — сайт не знает, чьим входом получен код.
Поэтому сайт обменивает код сразу, когда Notion возвращает браузер, а приложению отдаёт токены, зашифрованные его
одноразовым публичным ключом: ECDH P-256 → HKDF-SHA256 (`info` = `oats-oauth`) → AES-256-GCM, `sealed` = публичный
ключ сайта (65 байт) ‖ IV (12) ‖ шифротекст с тегом. Ключ приложения едет к Notion и обратно в `state`, сам `state`
приложения — associated data. Прочитать токены может только приложение, которое начало вход; у сайта ничего не
хранится, KV не нужен. Код на `/api/oauth/notion/token` не принимается — только обновление токена.

**Токены.** Notion отдаёт `refresh_token`, а `expires_in` не указан. Пара хранится в `oats-integrations.json` под
`safeStorage`; на `401` Oats один раз обновляет её (`grant_type: refresh_token`, через сайт, Basic + JSON) и
сохраняет новую пару — Notion выдаёт новый refresh-токен при каждом обновлении. Если не вышло — «Access expired —
connect Notion again» и кнопка **Connect again**.

## Куда пишем: база «Oats Notes»

Одна страница Notion на одну заметку Oats, все — в одной базе.

| Свойство | Тип | Откуда |
| --- | --- | --- |
| Name | title | `noteTitle(note)` |
| Date | date | `note.createdAt` |
| Attendees | text или multi-select | `note.attendees`: «Имя <почта>» |
| Folders | multi-select или text | названия папок заметки |
| Oats ID | text | `note.id` — найти страницу, если связь в Oats потерялась |

Перед записью Oats читает схему источника данных и пишет только свойства, которые там есть с подходящим типом;
title-свойство ищется по типу, так что переименованное «Name» тоже работает.

Как Oats находит базу после подключения, по порядку:

1. **Выбран шаблон.** `duplicated_template_id` — копия страницы-шаблона: `GET /v1/blocks/{id}/children` → блок
   `child_database` → `GET /v1/databases/{id}` → `data_sources[0].id`. Если шаблон сам база — сразу её.
2. **Переподключение того же воркспейса** — прежняя база, если она ещё доступна.
3. **База «Oats Notes»,** к которой уже есть доступ: `POST /v1/search` по источникам данных.
4. Иначе пользователь выбирает страницу (`POST /v1/search` по страницам, без строк баз) → `POST /v1/databases` с
   `initial_data_source.properties` из таблицы выше.

Если база пропала или к ней нет доступа (404 при чтении схемы), Oats забывает её и просит выбрать страницу заново.

## Сохранение заметки

Notion API `2026-03-11` принимает Markdown, так что свой перевод в блоки, как у Granola, не нужен.

- **Первый раз:** `POST /v1/pages` с `parent: {type: 'data_source_id', data_source_id}`, свойствами и `markdown` —
  телом заметки без заголовка (он в Name).
- **Повторно:** страница берётся из `pages[noteId]` в `oats-integrations.json`, а если её там нет — ищется по
  `Oats ID` (`POST /v1/data_sources/{id}/query`). Если она жива: `PATCH /v1/pages/{id}` со свойствами и
  `PATCH /v1/pages/{id}/markdown` с `replace_content`. Удалённая или в корзине — создаётся новая.
- Лимиты: ~3 запроса в секунду на подключение; на 429 и 529 Oats ждёт `Retry-After` (не больше 30 с, два раза).
  Сохранение — 3–5 запросов.

## Настройка

На сайте (подробно — в README oats-site): публичное подключение в Notion Developer portal, Redirect URI
`https://<сайт>/auth/callback`, `NOTION_CLIENT_ID` в `vars`, `NOTION_CLIENT_SECRET` через `wrangler secret put`;
по желанию — страница-шаблон «Oats Notes». В приложении достаточно `MAIN_VITE_AUTH_URL`: без сайта Notion не
подключается.

## Открытые вопросы

- Нужен ли транскрипт — например, свёрнутым блоком `<details>` внизу страницы?
- Авто-сохранение в Notion после Generate notes — отдельная настройка или не нужно?
- Дата встречи из календаря вместо `createdAt` — у заметки есть только `calendarEventId`, время события не хранится.
