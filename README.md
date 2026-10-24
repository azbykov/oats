# Oats — клон Granola

AI-блокнот для встреч в духе [Granola](https://granola.ai): пишете короткие заметки во время звонка, приложение
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
Deepgram и укажите ключ. **Settings → AI** — провайдер (Claude или OpenAI) и его ключ, **Settings → Calendar** — ICS-ссылка (необязательно).

При первой транскрипции macOS спросит доступ к микрофону и к **записи системного звука** (Core Audio Tap,
macOS 14.2+; на более старых macOS — «Запись экрана и системного звука»).

### Windows

Локальный Whisper, разделение собеседников и обнаружение звонков на Windows работают через Node-сайдкар
(whisper.cpp + sherpa-onnx), собирать Swift не нужно. Установщик `dist/Oats-Setup-<версия>.exe`:

```bash
npm run dist:win
```

Надёжнее собирать на самой Windows: там `npm install` сам поставит нужные нативные пакеты. В GitHub Actions это
делает `.github/workflows/build.yml` — собирает установщик на `windows-latest`, кладёт его в артефакт
`Oats-Setup` и прогоняет `scripts/smoke-sidecar.mjs` (все команды сайдкара на синтезированной речи) по собранному
приложению. Тот же workflow собирает `Oats.app` для Apple Silicon на `macos-26` (артефакт `Oats-mac-arm64`, zip).
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

### Загрузки на Cloudflare R2

На тегах `v*` job `publish` в `build.yml` кладёт обе сборки в бакет R2 (`scripts/publish-r2.sh`, S3 API):
`releases/<тег>/…` — неизменяемая копия каждой версии, `latest/Oats-Setup.exe` и `latest/Oats-mac-arm64.zip` — то, на
что ссылаются кнопки лендинга, `latest/version.json` — версия, дата, размеры и SHA-256. Исходящий трафик R2
бесплатный; в Pages файлы такого размера не помещаются (лимит 25 МиБ на файл).

Один раз в Cloudflare:

1. **R2 → Create bucket**, например `oats-downloads` (другое имя — задайте переменной репозитория `R2_BUCKET`).
2. Бакет → **Settings → Custom Domains** → поддомен лендинга, например `download.<домен>`. Публичный `r2.dev` только
   для проверки: у него ограничена частота запросов.
3. Если лендинг читает `version.json` с другого домена — бакет → **CORS policy**: `GET` с origin лендинга.
4. **R2 → Manage API tokens → Create API token**: Object Read & Write, только этот бакет.

В GitHub → **Settings → Secrets and variables → Actions**: секреты `R2_ACCOUNT_ID` (ID аккаунта Cloudflare),
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` из токена.

Релиз — тег с версией из `package.json` (иначе `publish` остановится):

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

Ссылки для лендинга: `https://download.<домен>/latest/Oats-Setup.exe` и `https://download.<домен>/latest/Oats-mac-arm64.zip`.
`latest/*` кешируются на 5 минут, `releases/*` — навсегда. Пока сборки не подписаны, на странице стоит предупредить про
SmartScreen на Windows и про `xattr -dr com.apple.quarantine` на Mac.

## Что есть

| Granola | Клон |
| --- | --- |
| Coming up (календарь) | ICS-фид: повторы (RRULE), EXDATE, TZID; кнопки Join / Take notes |
| Заметки + live-транскрипт Me/Them | Два потока (микрофон + loopback системного звука): локальный Whisper (WhisperKit) или Deepgram nova-3 |
| Generate / Enhance notes | Claude или OpenAI на выбор (стриминг), текст ИИ серым, ваши формулировки — тёмным |
| `granola-diarizer` (FluidAudio) | Свой `oats-audio diarize` на FluidAudio: «Speaker 1/2…» после паузы/остановки, переименование, узнавание голоса между сессиями |
| Шаблоны (1:1, Stand-up, Discovery…) | Встроенные + свои, перегенерация любым шаблоном |
| Обнаружение встречи (Notion: MicrophoneUsageMonitor) | `oats-audio watch-mic`: Zoom/Teams/FaceTime/Slack/браузер занял микрофон → баннер и уведомление «Take notes» |
| Резервная копия звука (Notion: meeting-notes failover) | Каждый канал пишется в WAV до обработки; при обрыве транскрипции или падении — пересборка транскрипта локальным Whisper |
| Ask anything + рецепты `/` | Чат по заметке или по всем заметкам, рецепты через `/` |
| Папки, поиск ⌘K, тёмная тема | Есть; экспорт в Markdown, копирование |

## Как устроено

- `src/main` — Electron main: окно, JSON-хранилище (`~/Library/Application Support/Oats/oats-data.json`),
  вызовы Claude / OpenAI (`ai.ts`), парсер ICS (`ics.ts`), обработчик системного звука.
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
    (Apache-2.0, pyannote/WeSpeaker в CoreML); интерфейс повторяет `granola-diarizer`. Модели (~22 МБ) — в
    `~/Library/Application Support/FluidAudio`. Системный звук пишется во временный WAV 16 кГц, который удаляется
    сразу после диаризации; строки транскрипта режутся по смене говорящего по таймкодам слов.
  - `transcribe` — пакетная расшифровка записанного WAV (восстановление после сбоя); `watch-mic` — какие приложения
    пишут с микрофона (Core Audio process objects, macOS 14.2+).
- Захват звука (как в Notion): системный звук — Chromium-фича `MacCatapLoopbackAudioForScreenShare` (Core Audio Tap),
  аудио-only `getDisplayMedia` без захвата экрана; микрофон — сырой, с `echoCancellation: "all"`, который вычитает всё,
  что играет Mac, поэтому собеседники из динамиков не попадают в «Me».
- `src/renderer` — React 19 + TipTap + Tailwind 4; палитра «oats» взята из дизайн-токенов Granola.

Структура данных и UX восстановлены статическим анализом установленного `Granola.app` (v7.668.2) через REA:
`app.asar` (Electron + React/TipTap), preload-API, CSS-токены, тексты интерфейса. Серверная часть Granola
(шаблоны, промпты, синхронизация) в приложении не поставляется — здесь она заменена прямыми вызовами Claude и Deepgram.
Проприетарные шрифты и ассеты Granola не копировались.

## Ограничения

- Нет облака, шаринга, интеграций (Slack, Notion, CRM) и OAuth-календарей. Запись при обнаружении звонка не стартует
  сама — только по кнопке «Take notes».
- Разделяются только собеседники из системного звука; люди рядом с вами в одной комнате попадают в «Me».
- Сайдкар не упаковывается в сборку автоматически: в продакшне положите его в `Resources/oats-audio`
  или укажите путь в `OATS_AUDIO_PATH`.
- Локальный Whisper даёт текст с задержкой ~1–2 с (Deepgram — почти мгновенно) и заметно грузит Mac на длинных звонках.
- `OATS_USER_DATA=/путь npm run dev` — запуск с отдельной папкой данных.
- Windows: системный звук берётся только с устройства вывода по умолчанию. Если звонок играет в гарнитуру, которая
  не выбрана по умолчанию, собеседников не будет слышно — Granola для Teams специально следует за устройством
  звонка, здесь этого пока нет. Обнаружение звонков опрашивает реестр раз в 1,5 с.
