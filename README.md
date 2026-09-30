# Agent Control — Coding Runner

Отдельный Node.js/TypeScript сервис, который выполняет задачи по коду в изолированной рабочей копии.
Agent Control (веб-приложение) только ставит задания и получает статусы — в браузере и в серверных функциях
приложения shell/Git/Claude Code **не запускаются**.

## Что делает
1. Принимает задание `{ task, repositoryId, baseBranch, allowedOperations[], timeLimitSec, callbackUrl }`.
2. Ищет `repositoryId` в серверном allowlist (`repos.json`). Произвольные URL/пути от пользователя не принимаются.
3. Клонирует репозиторий в отдельный каталог задания, создаёт ветку `agent/<jobId>`.
4. Запускает агента (Claude Agent SDK) только с инструментами Read/Glob/Grep (+Edit/Write если разрешён `write`).
   Инструмент Bash отключён; команды тестов берутся **только** из `testCommands` в конфиге (argv, без shell).
5. Собирает `changedFiles`, `diff`, результаты тестов, логи, usage → сохраняет артефакт.
6. Шлёт HMAC-подписанные callbacks в Agent Control; polling `GET /jobs/:id` — резервный путь.

Никогда: merge, push, deploy, git config изменения вне рабочей копии, доступ к секретам приложения.

## API (все запросы: `Authorization: Bearer $RUNNER_API_KEY`)
| Метод | Путь | Описание |
|---|---|---|
| GET | /health | статус, версия, драйвер агента |
| POST | /jobs | создать (заголовок `Idempotency-Key` обязателен; повтор → тот же `jobId`) |
| GET | /jobs/:id | статус, seq, логи, результат |
| POST | /jobs/:id/cancel | отмена (queued → сразу, running → abort + kill процессов) |
| GET | /jobs/:id/result | `{ summary, changedFiles, diff, testResults, branch, usage }` |
| GET | /jobs/:id/artifact | diff как text/plain |

Статусы: `queued, running, succeeded, failed, cancelled, timed_out`.
Callback: `POST callbackUrl` с заголовками `X-Runner-Event-Id`, `X-Runner-Timestamp`,
`X-Runner-Signature: v1=hex(HMAC_SHA256(secret, "<ts>.<eventId>.<rawBody>"))`, тело содержит монотонный `seq`.
Приложение отбрасывает старые (±5 мин), повторные и out-of-order события.

## Развёртывание
```bash
cp .env.example .env                  # заполнить секреты
cp config/repos.example.json config/repos.json
docker compose -f docker-compose.example.yml up -d --build
curl -H "Authorization: Bearer $RUNNER_API_KEY" https://runner.example.com/health
```
Сервис должен быть доступен по HTTPS (reverse proxy / платформа). Рекомендуется gVisor (`runtime: runsc`),
отдельная VM/контейнер без docker.sock, read-only rootfs, лимиты CPU/памяти/pids (см. compose).

## Подключение к Agent Control
В секретах проекта Agent Control задать:
- `RUNNER_BASE_URL` — https-адрес runner
- `RUNNER_API_KEY` — тот же, что в `.env` runner
- `RUNNER_CALLBACK_SECRET` — тот же, что в `.env` runner

В runner `ALLOWED_CALLBACK_ORIGINS` = адрес опубликованного приложения. Затем «Connections → Coding runner → Проверить».

## Тесты
```bash
npm install && npm test   # uses tsx --test; do not run with `bun test` (unsupported runner)
```
Тесты — mock-уровень: настоящий HTTP-сервер, git, команды тестов, но **фиктивный драйвер агента** (без вызова Anthropic).
Если окружение запрещает git-запись, тесты полного цикла помечаются SKIP.

## Известные ограничения
- Хранение заданий — JSON-файлы, один процесс. Для нескольких реплик нужен общий store/lock.
- При рестарте выполнявшиеся задания помечаются `failed` (перезапуск делает приложение с новым attempt).
- Изоляция процессов тестов ограничена контейнером; для недоверенных репозиториев обязателен gVisor/отдельная VM.

## Budget and artifacts (contract v1, features: budget, setup-results, artifacts)

Each job request may carry `budget: { maxTokens, maxCostUsd }`. Values are clamped
to `MAX_TOKENS_CAP` / `MAX_COST_USD_CAP`; `null` means no app-side limit. The agent is
stopped as soon as the token budget is passed, and the job still returns whatever diff
and test output it produced, with `budgetExceeded: true`.

Job results now include `setupResults` and `testResults` entries of the shape
`{ phase, command, exitCode, timedOut, durationMs, output }` (output truncated to 20 KB,
secrets redacted by the exec layer). `GET /health` advertises `features` and `limits`.

### Deployment steps still required (not done by Lovable)

1. Host the runner yourself (Docker image in this folder) with network access to your git host.
2. Set `RUNNER_API_KEY`, `RUNNER_CALLBACK_SECRET`, `ANTHROPIC_API_KEY`, `ALLOWED_CALLBACK_ORIGINS`,
   and `config/repos.json` with the repositories the agent may clone.
3. In the app: Connections → Coding Runner, enter the runner base URL, API key and callback secret.
4. Only then does Live Mode execute real coding jobs; without it the step fails with an explicit error.
