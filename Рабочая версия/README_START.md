# Warehouse MVP — быстрый старт на macOS

Ниже — самый простой сценарий “скачал ZIP → запустил”.

## 1) Подготовка (один раз)
1. Установите **Node.js 20 LTS** с https://nodejs.org/
2. Проверьте, что Node установлен:
   ```bash
   node -v
   npm -v
   ```

## 2) Распаковка
1. Распакуйте ZIP в удобную папку.
2. Откройте Терминал и перейдите в папку проекта.

## 3) Запуск backend
```bash
cd backend
cp .env.example .env
# откройте backend/.env и вставьте ваш MOYSKLAD_TOKEN
npm ci
npm run doctor
npm run smoke
npm start
```

**Что должно быть в терминале при успехе:**
- `Doctor check: всё выглядит готовым к запуску.`
- `Smoke test: /api/health отвечает корректно.`
- `Warehouse API running at http://localhost:3001`

## 4) Запуск frontend (в новом окне терминала)
```bash
cd frontend
npm ci
npm run dev
```

Откройте URL, который покажет Vite (обычно http://localhost:5173).

## Частые проблемы и решения
### ❌ “Missing .env file” или “Missing MOYSKLAD_TOKEN”
Проверьте, что в `backend/.env` есть строка:
```
MOYSKLAD_TOKEN=ВАШ_ТОКЕН
```
Если у вас доступ через логин/пароль, используйте:
```
MOYSKLAD_LOGIN=...
MOYSKLAD_PASSWORD=...
```

### ❌ “Порт 3001 уже занят”
Закройте приложение, которое использует порт 3001, или добавьте в `.env`:
```
PORT=3002
```

## Заметки
- `backend/warehouse.db` создаётся автоматически на первом запуске.
- `.env` и `node_modules` в репозиторий не коммитятся.
