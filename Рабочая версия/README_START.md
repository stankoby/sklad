# Warehouse MVP (Packing + Boxes)

## Requirements
- Node.js **20 LTS** recommended (works best). If you use nvm: `nvm use` will pick it up.

## First run (from project root)
### Backend
```bash
cd backend
cp .env.example .env
# put your real MOYSKLAD_TOKEN into backend/.env
npm install
npm run dev
```

### Frontend (new terminal)
```bash
cd frontend
npm install
npm run dev
```

Open the URL shown by Vite (usually http://localhost:5173).

## Notes
- `backend/warehouse.db` is created automatically on first backend start (schema is created by `backend/database.js`).
- Do **NOT** commit `.env` or `node_modules`.
