# 40K Tier List

Аналитический тирлист отрядов Warhammer 40,000 11-й редакции. Проект:

- читает реальные JSON-даташиты [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e);
- переводит состав отряда в боевой профиль (`T/W/Sv`, оружие, способности);
- считает урон Монте-Карло в дальнем, ближнем и комбинированном бою;
- оценивает живучесть и урон на 100 очков;
- применяет Melee Tax, Utility Score, min-max нормализацию и перцентильные тиры;
- предоставляет статический сайт с фильтрами и редактором характеристик юнита.

## Возможности сайта

- выбор фракции;
- режим: **Дальний**, **Ближний**, **Комбинированный**;
- фильтр по тирам S/A/B/C/D;
- поиск и сортировка;
- отображение урона по пехоте, броне и универсального показателя;
- отображение живучести, utility, нормализованных значений, Total Score и перцентиля;
- редактирование очков, T/W/Sv/InSv и основных параметров оружия с пересчётом тира.

Изменения редактора не записываются в исходный BSData: они действуют только в текущей сессии браузера.

## Требования

- Node.js **22 или новее**;
- npm;
- исходные BSData в `public/BSData/wh40k-11e` (это git submodule).

При первом клонировании репозитория BSData нужно инициализировать:

```bash
git clone --recurse-submodules https://github.com/<user>/40k-tierlist.git
cd 40k-tierlist
```

Если репозиторий уже скачан без submodule:

```bash
git submodule update --init --recursive
```

Проверить версию:

```bash
node --version
npm --version
```

В репозитории сейчас нет lock-файла, поэтому для локальной установки используйте `npm install`. После фиксации зависимостей рекомендуется добавить и использовать `package-lock.json` вместе с `npm ci`.

## Быстрый запуск

```bash
npm install
npm run dev
```

Vite откроет сайт на локальном адресе, обычно:

```text
http://localhost:5173
```

Для запуска с уже собранным JSON:

```bash
npm run dev
```

Если `web/public/data/tierlist.json` отсутствует, сначала выполните:

```bash
npm run build:data
```

## Команды

| Команда | Назначение |
|---|---|
| `npm run dev` | запуск Vite в development-режиме |
| `npm run build` | production-сборка сайта в `dist/` |
| `npm run preview` | локальный просмотр production-сборки |
| `npm run build:data` | пересчёт всех юнитов и генерация `web/public/data/tierlist.json` |
| `npm test` | полный набор Vitest-тестов |
| `npm run test:watch` | тесты в watch-режиме |
| `npm run typecheck` | проверка TypeScript без emit |
| `npm run report:bsdata` | отчёт по разбору BSData |
| `npm run report:wahapedia` | отчёт по CSV Wahapedia |

`build:data` по умолчанию использует 40 Монте-Карло-прогонов. Для быстрой проверки можно передать меньшее число:

```bash
node scripts/build-tierlist.ts --trials=10
```

Параметры сборщика:

```text
--trials=25    число Монте-Карло-прогонов
--distance=12  дистанция для расчёта выживаемости
--out=path     путь к JSON
```

Полный пересчёт 1288 юнитов занимает заметное время. Для production-деплоя рекомендуется запускать его в CI или заранее кэшировать готовый JSON.

## Структура

```text
src/bsdata/       парсер BattleScribe/BSData
src/combat/       правила, кубики, Монте-Карло, архетипы, выживаемость
src/tier/         scoring, utility-флаги и перцентильные тиры
web/              статический интерфейс тирлиста
web/public/data/  сгенерированные данные тирлиста
scripts/          CLI-отчёты и сборщик данных
public/BSData/    исходные JSON-файлы BSData
.github/workflows/ CI и деплой GitHub Pages
```

## Проверка перед коммитом

```bash
npm run typecheck
npm test
npm run build
```

## Деплой на GitHub Pages

В репозитории есть автоматический workflow:

```text
.github/workflows/deploy-pages.yml
```

Он выполняет:

1. установку зависимостей;
2. `npm run typecheck`;
3. `npm test`;
4. `npm run build:data`;
5. `npm run build`;
6. публикацию `dist/` через GitHub Pages.

### Настройка репозитория

1. Откройте **Settings → Pages**.
2. В **Build and deployment** выберите **Source: GitHub Actions**.
3. Отправьте изменения в ветку `main` или запустите workflow вручную через **Actions → Deploy Pages → Run workflow**.

Адрес сайта будет вида:

```text
https://<user>.github.io/<repository>/
```

Если для репозитория или сайта нужен другой способ деплоя, workflow можно заменить на аналогичный для Netlify, Cloudflare Pages или любого другого статического хостинга: на вход подаётся готовая папка `dist/`.

## Лицензия и данные

Код проекта распространяется по лицензии MIT. JSON-файлы BSData имеют собственную лицензию и происхождение; при публикации сайта следует соблюдать условия репозитория [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e). Warhammer 40,000 и связанные названия — trademarks Games Workshop; проект не связан с Games Workshop и не одобрен ею.
