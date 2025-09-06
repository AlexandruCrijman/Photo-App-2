## Photo App 2

React frontend + Node/Express backend + Postgres (Docker) + OpenAI SDK.

### Prerequisites
- Node.js (installed via nvm)
- Docker Desktop (for Postgres)

### Setup
1. Copy env file:
   - `cp .env.example .env`
   - Fill in `OPENAI_API_KEY`.
2. Start Postgres (Docker):
   - `docker compose up -d`
3. Install and run backend:
   - `cd backend && npm install && npm run dev`
4. Install and run frontend:
   - `cd frontend && npm install && npm run dev`

### Health Check
- Backend: `GET http://localhost:4000/health`


