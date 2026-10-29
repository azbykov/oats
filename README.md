# Oats

AI-блокнот для встреч: пишете короткие заметки во время звонка, приложение
транскрибирует ваш микрофон («Me») и системный звук собеседников («Them») без бота в созвоне, а после встречи
Claude превращает ваши заметки и транскрипт в аккуратный конспект по шаблону.

## Запуск

```bash
npm install
```

```bash
npm run dev
```

Локальная транскрипция (Whisper) и разделение собеседников работают в нативном Swift-сайдкаре
(Apple Silicon). Соберите его один раз (несколько минут):

```bash
npm run build:native
```

Дальше: **Settings → Transcription** — по умолчанию Whisper на этом Mac: нажмите **Download** у модели
(large-v3 turbo, 632 МБ; скачивание и оптимизация под ваш Mac — несколько минут, один раз). Либо переключитесь на
Deepgram и укажите ключ. **Settings → AI** — провайдер (Claude или OpenAI) и его ключ, **Settings → Accounts** — вход
через Google или Яндекс для календарей, **Settings → Calendar** — ICS-ссылка (необязательно).

При первой транскрипции macOS спросит доступ к микрофону и к **записи системного звука** (Core Audio Tap,
macOS 14.2+; на более старых macOS — «Запись экрана и системного звука»).

### Аккаунты Google и Яндекс

Вход открывает страницу согласия в системном браузере, редирект ловится на `http://127.0.0.1:47821/oauth/callback`
(OAuth для нативных приложений с PKCE). Можно подключить несколько аккаунтов; в «Coming up»
попадают события из отмеченных календарей вместе с ICS-фидом, повторы одной встречи склеиваются. Токены хранятся
только в main-процессе, в `oats-accounts.json`, зашифрованные `safeStorage` (Keychain / DPAPI).

OAuth задаётся при сборке: скопируйте `.env.example` в `.env` и выберите один из вариантов.

**Через сайт Oats** (репозиторий `oats-site`, Cloudflare Worker) — `MAIN_VITE_AUTH_URL=https://<сайт>`. OAuth-клиенты
и их секреты живут на сайте: он открывает страницу согласия, служит Redirect URI (`https://<сайт>/auth/callback`),
пересылает ответ на локальный порт приложения и добавляет секрет к обмену кода и обновлению токенов. В приложении
нет ни client ID, ни секретов; Google-клиент — типа **Web application**. Настройка — в README сайта. Сборки в
GitHub Actions (там `.env` нет) идут этим путём: `build.yml` задаёт `MAIN_VITE_AUTH_URL` — по умолчанию
`https://oats-site.azbykov.workers.dev`, другой адрес задаётся переменной репозитория `MAIN_VITE_AUTH_URL`.

**Напрямую** — свои клиенты в приложении:

- **Google**: [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → включите Google Calendar
  API → OAuth consent screen (scope `calendar.readonly`; пока приложение в режиме Testing — добавьте себя в Test
  users) → Credentials → OAuth client ID, тип **Desktop app** → `MAIN_VITE_GOOGLE_CLIENT_ID` и
  `MAIN_VITE_GOOGLE_CLIENT_SECRET` (для Desktop-клиентов секрет не считается секретным).
- **Яндекс**: [oauth.yandex.ru](https://oauth.yandex.ru/client/new) → платформа «Веб-сервисы», Redirect URI
  `http://127.0.0.1:47821/oauth/callback`; доступы: Яндекс ID — почта, имя и портрет; Календарь — чтение (CalDAV)
  → `MAIN_VITE_YANDEX_CLIENT_ID`. Календарь читается по CalDAV (`caldav.yandex.ru`) с OAuth-токеном.

### Windows

Локальный Whisper, разделение собеседников и обнаружение звонков на Windows работают через Node-сайдкар
(whisper.cpp + sherpa-onnx), собирать Swift не нужно. Установщик `dist/Oats-Setup-<версия>.exe`:

```bash
npm run dist:win
```

Надёжнее собирать на самой Windows: там `npm install` сам поставит нужные нативные пакеты. Там же `dist:win` кладёт рядом с
`onnxruntime-node` библиотеки Visual C++ Runtime из установленной Visual Studio (`scripts/copy-vcruntime.mjs`):
без них поиск по смыслу не запустится на ПК без VC++ Redistributable. При сборке на Mac скопировать их неоткуда — скрипт
только предупреждает. В GitHub Actions сборку
делает `.github/workflows/build.yml` — собирает установщик на `windows-latest`, кладёт его в артефакт
`Oats-Setup` и прогоняет `scripts/smoke-sidecar.mjs` (все команды сайдкара на синтезированной речи) и
`scripts/smoke-embedder.mjs` (ONNX runtime поиска по смыслу и библиотеки VC++ рядом с ним) по собранному
приложению. Тот же workflow собирает `Oats.app` для Apple Silicon на `macos-26` (артефакт `Oats-mac-arm64`, zip)
и для Intel на `macos-15-intel` (артефакт `Oats-mac-x64`, zip; перед упаковкой — тот же smoke-тест сайдкара).
Приложение подписано ad hoc, без Developer ID и нотаризации, поэтому после скачивания снимите карантин:
`xattr -dr com.apple.quarantine /Applications/Oats.app`.

При сборке на Mac сначала доставьте Windows-версии аддонов (а сам установщик соберётся только с Rosetta):

```bash
npm run deps:win
```

В **Settings → Transcription** — модели whisper.cpp (по умолчанию small, на видеокарте через Vulkan, если она
есть). Системный звук — loopback устройства вывода по умолчанию, разрешений не требует; доступ к микрофону —
переключатель в «Параметры → Конфиденциальность и защита → Микрофон». Установщик не подписан, поэтому при
первом запуске SmartScreen покажет предупреждение.

Node-сайдкар можно запустить и на Mac (например, на Intel): `OATS_AUDIO_ENGINE=node npm run dev`.

### Intel Mac

WhisperKit и FluidAudio работают только на Apple Silicon, поэтому Intel-версия использует тот же Node-сайдкар,
что и Windows (whisper.cpp + sherpa-onnx), и модели whisper.cpp в Settings. Системный звук и разрешения — как на
Apple Silicon (Core Audio Tap на macOS 14.2+; модуль `native/tcc` собирается универсальным, arm64 + x86_64).
Сборка с любого Mac, результат — `dist/mac/Oats.app`:

```bash
npm run dist:mac-x64
```

Скрипт доставляет x64-версии аддонов (`npm run deps:mac-x64`) и собирает по `electron-builder.mac-x64.yml`
(без Swift-помощника и arm64-аддонов). Apple Silicon собирается по `electron-builder.mac-arm64.yml`
(`npm run dist:mac`); общие настройки — в `electron-builder.yml`. На Apple Silicon Intel-сборку можно запустить
только с установленным Rosetta.

### Загрузки на Cloudflare R2

На тегах `v*` job `publish` в `build.yml` кладёт все три сборки в бакет R2 (`scripts/publish-r2.sh`, S3 API):
`releases/<тег>/…` — неизменяемая копия каждой версии, `latest/Oats-Setup.exe`, `latest/Oats-mac-arm64.zip` и
`latest/Oats-mac-x64.zip` — то, на что ссылаются кнопки лендинга, `latest/version.json` — версия, дата, размеры и SHA-256 (по нему приложение показывает карточку «Oats X» с
кнопкой Download), `latest/latest.yml` — фид `electron-updater`: Windows сам скачивает установщик и ставит его при
перезапуске. Исходящий трафик R2
бесплатный; в Pages файлы такого размера не помещаются (лимит 25 МиБ на файл).

Один раз в Cloudflare:

1. **R2 → Create bucket**, например `oats-downloads` (другое имя — задайте переменной репозитория `R2_BUCKET`).
2. **R2 → Manage API tokens → Create API token**: Object Read & Write, только этот бакет.

Когда появится свой домен, можно вместо воркера подключить его к бакету напрямую (**Settings → Custom Domains**);
публичный `r2.dev` годится только для проверки — у него ограничена частота запросов.

В GitHub → **Settings → Secrets and variables → Actions**: секреты `R2_ACCOUNT_ID` (ID аккаунта Cloudflare),
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` из токена.

Релиз — тег с версией из `package.json` (иначе `publish` остановится):

```bash
git tag v0.1.1
```

```bash
git push origin v0.1.1
```

Файлы отдаёт воркер лендинга (`oats-site`, маршрут `/download/*` с привязкой к бакету), так что свой домен и CORS не
нужны: `https://oats-site.azbykov.workers.dev/download/latest/Oats-Setup.exe`,
`…/download/latest/Oats-mac-arm64.zip`, `…/download/latest/Oats-mac-x64.zip`, `…/download/latest/version.json`. Браузеры держат `latest/*` в кеше 5 минут,
`releases/*` — навсегда; на `workers.dev` CDN-кеша нет, каждая загрузка — одно чтение из R2. Пока сборки не подписаны, на странице стоит предупредить про
SmartScreen на Windows и про `xattr -dr com.apple.quarantine` на Mac.

## Что есть

| Функция | Как сделано |
| --- | --- |
| Coming up (календарь) | Аккаунты Google (Calendar API) и Яндекс (CalDAV) через OAuth + ICS-фид: повторы (RRULE), EXDATE, TZID; кнопки Join / Take notes |
| Заметки + live-транскрипт Me/Them | Два потока (микрофон + loopback системного звука): локальный Whisper (WhisperKit) или Deepgram nova-3 |
| Generate / Enhance notes | Claude или OpenAI на выбор (стриминг), текст ИИ серым, ваши формулировки — тёмным |
| Разделение собеседников | `oats-audio diarize` на FluidAudio: «Speaker 1/2…» после паузы/остановки, переименование, узнавание голоса между сессиями |
| Шаблоны (1:1, Stand-up, Discovery…) | Встроенные + свои, перегенерация любым шаблоном |
| Обнаружение встречи | `oats-audio watch-mic`: Zoom/Teams/FaceTime/Slack/браузер занял микрофон → баннер и уведомление «Take notes» |
| Резервная копия звука | Каждый канал пишется в WAV до обработки; при обрыве транскрипции или падении — пересборка транскрипта локальным Whisper |
| Ask anything + рецепты `/` | Чат по заметке, по папке или по всем заметкам: поиск (BM25 + смысловой) выбирает самые подходящие встречи, ответ ссылается на них (`meeting://`), рецепты через `/` |
| Поиск по смыслу | Локальная модель multilingual-e5-small (int8, 118 МБ, скачивается в **Settings → AI**) на `onnxruntime-node`: заметки, конспекты и транскрипт режутся на фрагменты ~1000 символов, индексируются через минуту после последнего изменения (не во время звонка), поиск — косинус по всем фрагментам в памяти. Работает между русским и английским; в чате сливается с BM25 (RRF), в ⌘K — блок «Related by meaning» |
| @-упоминания | `@` в заметке — люди из встреч; при наведении карточка: почта, общие встречи |
| Редактирование | Удаление строк транскрипта, вставка без форматирования ⌘⇧V, предупреждение перед удалением правленого конспекта |
| Focus mode | ⌘⇧F: без сайдбара, шапка появляется при наведении; Esc — выход |
| Папки, поиск ⌘K, тёмная тема | Есть; экспорт в Markdown, копирование |
| Save to Notion | **Settings → Integrations**: подключение через сайт Oats, база «Oats Notes»; открытая вкладка заметки уходит на свою страницу (Markdown API Notion), повторное сохранение её обновляет — см. [docs/notion.md](docs/notion.md) |

## Как устроено

- `src/main` — Electron main: окно, хранилище SQLite (`~/Library/Application Support/Oats/oats.db`, встроенный
  `node:sqlite`, WAL; строки транскрипта — отдельные записи, поиск — FTS5 с trigram; старый `oats-data.json`
  переносится при первом запуске и остаётся как `oats-data.json.bak`),
  вызовы Claude / OpenAI (`ai.ts`), парсер ICS (`ics.ts`), обработчик системного звука; вход через Google / Яндекс
  (`oauth.ts`, `accounts.ts`) и их календари (`google.ts`, `yandex.ts`, сводит всё `calendar.ts`); Notion
  (`integrations.ts`, `notion.ts`).
- `src/preload` — мост `window.oats`.
- `src/sidecar` — тот же CLI `oats-audio` на Node (Windows, Intel Mac): `listen` / `transcribe` / `prepare-asr` на
  whisper.cpp ([`@fugood/whisper.node`](https://github.com/mybigday/whisper.node), MIT; ggml-модели в
  `<appData>/Oats/models/ggml`), Silero VAD и `diarize` / `embed` на [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
  (Apache-2.0; pyannote segmentation 3.0 + WeSpeaker, ~32 МБ в `<appData>/Oats/models/sherpa`), `watch-mic` — записи
  `CapabilityAccessManager` в реестре Windows. Собирается в `out/main/oats-audio.js` и запускается Electron'ом
  с `ELECTRON_RUN_AS_NODE`; к финалам подмешивается подсказка из недавнего текста канала.
- `native/audio` — Swift-CLI `oats-audio`:
  - `listen` — потоковая локальная транскрипция на [WhisperKit](https://github.com/argmaxinc/WhisperKit) (MIT,
    CoreML/Neural Engine). Whisper не потоковый, поэтому каждый канал режется энергетическим VAD: пока человек говорит,
    раз в секунду идёт частичная расшифровка, после паузы ~0.7 с — финальная, с таймкодами слов. Модели — в
    `~/Library/Application Support/Oats/models` (`prepare-asr` скачивает и компилирует их).
  - `diarize` / `embed` — разделение собеседников на [FluidAudio](https://github.com/FluidInference/FluidAudio)
    (Apache-2.0, pyannote/WeSpeaker в CoreML). Модели (~22 МБ) — в
    `~/Library/Application Support/FluidAudio`. Системный звук пишется во временный WAV 16 кГц, который удаляется
    сразу после диаризации; строки транскрипта режутся по смене говорящего по таймкодам слов.
  - `transcribe` — пакетная расшифровка записанного WAV (восстановление после сбоя); `watch-mic` — какие приложения
    пишут с микрофона (Core Audio process objects, macOS 14.2+).
- Захват звука (как в Notion): системный звук — Chromium-фича `MacCatapLoopbackAudioForScreenShare` (Core Audio Tap),
  аудио-only `getDisplayMedia` без захвата экрана; микрофон — сырой, с `echoCancellation: "all"`, который вычитает всё,
  что играет Mac, поэтому собеседники из динамиков не попадают в «Me».
- `src/renderer` — React 19 + TipTap + Tailwind 4, палитра «oats».

Своего облака нет: шаблоны и промпты встроены в приложение, ИИ и транскрипция — прямые вызовы Claude / OpenAI и
Deepgram с ключами пользователя.

## Ограничения

- Нет облака, шаринга и интеграций, кроме Notion (Slack, CRM — нет). Notion подключается только через сайт Oats
  (`MAIN_VITE_AUTH_URL`). Запись при обнаружении звонка не стартует
  сама — только по кнопке «Take notes».
- Поиск по смыслу есть только на Apple Silicon и Windows x64: у `onnxruntime-node` нет сборки для Intel Mac.
- Разделяются только собеседники из системного звука; люди рядом с вами в одной комнате попадают в «Me».
- Сайдкар не упаковывается в сборку автоматически: в продакшне положите его в `Resources/oats-audio`
  или укажите путь в `OATS_AUDIO_PATH`.
- Локальный Whisper даёт текст с задержкой ~1–2 с (Deepgram — почти мгновенно) и заметно грузит Mac на длинных звонках.
- `OATS_USER_DATA=/путь npm run dev` — запуск с отдельной папкой данных.
- Windows: системный звук берётся только с устройства вывода по умолчанию. Если звонок играет в гарнитуру, которая
  не выбрана по умолчанию, собеседников не будет слышно: следовать за устройством звонка (как нужно для Teams)
  приложение пока не умеет. Обнаружение звонков опрашивает реестр раз в 1,5 с.
