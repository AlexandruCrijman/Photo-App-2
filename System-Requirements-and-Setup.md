# System Requirements and Setup Guide

This document lists everything you need installed to run the Photo Classification Album with AI locally, including OS prerequisites, runtimes, system tools, models, environment variables, and basic run commands.

## 1) Supported Platforms
- macOS 13+ (Intel or Apple Silicon)
- Linux (Ubuntu 22.04+ or similar)
- Windows 11 (WSL2 recommended)

## 2) Core Runtimes and Tools
- Node.js (LTS or newer; tested with Node 20/22)
  - Recommended: install via `nvm`
- npm 10+ (bundled with Node)
- Git (for cloning/pull/push)
- Docker Desktop (recommended) OR a local PostgreSQL 14+
- curl (for API checks)
- jq (optional, for pretty-printing API JSON)

### Quick checks
```bash
node -v
npm -v
git --version
curl --version
jq --version   # optional
```

### macOS prerequisites
- Xcode Command Line Tools (first time only):
```bash
xcode-select --install
```

## 3) Database
You can run PostgreSQL in Docker or install locally. The app expects a DB reachable at `postgres://postgres:postgres@localhost:5432/photo_app` by default.

### Option A: Docker (recommended)
```bash
# pull and run

docker run --name photo-app-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=photo_app -p 5432:5432 -d postgres:15

# verify

docker ps | grep photo-app-postgres
```

### Option B: Local install
- macOS (Homebrew):
```bash
brew install postgresql@15
brew services start postgresql@15
createdb photo_app
```
- Ubuntu (apt):
```bash
sudo apt update && sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE DATABASE photo_app;"
```

## 4) Project Structure and Install
```bash
# clone
git clone git@github.com:AlexandruCrijman/Photo-App-2.git
cd Photo-App-2

# frontend deps
cd frontend && npm install && cd ..

# backend deps
cd backend && npm install && cd ..
```

## 5) Models (AI Inference)
Place model files under `backend/models/` and set env vars accordingly. Preferred, community-tested variants:

- SCRFD face detection (InsightFace):
  - Recommended: `scrfd_2.5g_bnkps.onnx` or `scrfd_500m_bnkps.onnx`
  - Source: https://github.com/deepinsight/insightface/releases/tag/v0.7
- ArcFace face recognition (InsightFace):
  - Example: `arcface_r50.onnx`
  - Source: https://github.com/deepinsight/insightface/releases
- OSNet person re-identification (appearance):
  - Example: `osnet_x0_25.onnx`
  - Source: https://github.com/KaiyangZhou/deep-person-reid

After downloading:
```bash
mkdir -p backend/models
# Copy the .onnx files into backend/models
```

Notes:
- Ensure the ONNX opset of the model is compatible with your installed `onnxruntime-node`.
- If a model fails to load (protobuf error), switch to the recommended SCRFD variants above.

## 6) Environment Variables
Create `backend/.env` (or export in shell) with:
```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/photo_app
FRONTEND_ORIGIN=http://localhost:5173
OPENAI_API_KEY=your_key_here   # Required for GPT-backed description/people endpoints

# Models
SCRFD_MODEL_PATH=models/scrfd_2.5g_bnkps.onnx    # or scrfd_500m_bnkps.onnx
ARCFACE_MODEL_PATH=models/arcface_r50.onnx       # recognition (future step)
OSNET_MODEL_PATH=models/osnet_x0_25.onnx         # appearance (future step)

# Detection safety net
DETECT_TIMEOUT_MS=8000
```

## 7) Initialize and Run
```bash
# 1) Migrate DB (idempotent)
cd backend
npm run migrate

# 2) Start backend (dev)
# Recommended for stability during debugging:
node src/index.js
# Or nodemon:
# npm run dev

# 3) Start frontend (dev)
cd ../frontend
npm run dev
# Vite prints a local URL, e.g. http://localhost:5173
```

## 8) Basic Health and API Checks
```bash
# health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/health

# upload one photo (adjust path)
curl -s -X POST -F "photo=@/absolute/path/to/photo.jpg" http://localhost:4000/photos

# detect faces on a photo id
curl -s -X POST http://localhost:4000/photos/123/faces:detect
curl -s http://localhost:4000/photos/123/faces
```

## 9) Troubleshooting Quick Reference
- Health endpoint returns 000 / hangs
  - Run backend without nodemon: `node src/index.js`
  - Unset proxies: `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy`
  - Confirm listener: `lsof -n -P -iTCP:4000 -sTCP:LISTEN` and `nc -vz 127.0.0.1 4000`
- SCRFD model load fails (protobuf parsing)
  - Use `scrfd_2.5g_bnkps.onnx` or `scrfd_500m_bnkps.onnx` from InsightFace v0.7
  - Verify file path and permissions
- Detect returns 0 boxes consistently
  - Verify model output parsing matches the selected model; try recommended SCRFD variants
  - Lower thresholds temporarily; test with images containing large, clear faces
- sharp errors for tiny test fixtures
  - Use real JPEGs/PNGs for validation; tiny fixtures are only for minimal tests

## 10) Optional Utilities
- nvm (Node Version Manager): simplify Node upgrades/downgrades
- Homebrew (macOS): quick installs for jq, git, postgres
- Docker Desktop: consistent local Postgres; easy resets

---
With these dependencies and steps, the app should build, start, and serve both the frontend and backend locally. Adjust model paths and env vars as you iterate on the AI pipeline.
