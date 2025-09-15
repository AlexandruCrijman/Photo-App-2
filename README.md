# Photo Classification Album with AI – TODO and Current Issues

## Overview
Monolithic app (React + Vite frontend, Node/Express backend, PostgreSQL DB) with AI features for description, secure share links, and people detection/recognition (SCRFD + ArcFace + OSNet).

## Remaining TODOs
- Face/People pipeline
  - Implement ArcFace embeddings extraction for detected faces; persist in `faces` and `person_embeddings`.
  - Implement OSNet appearance embeddings; fuse with ArcFace for recognition robustness (multi-angle, clothing).
  - Add recognition endpoint to associate detections to existing tags; persist `recognized_tag_id` and fused scores.
  - Batch/maintenance job to rebuild/freshen `person_embeddings` when tags/photos change.
  - Tuning at wedding scale: thresholds, NMS, dynamic scaling, cap processed faces, perf QA.
- Frontend UI
  - Overlay: ensure canvas boxes render reliably for large images; add hover highlights and confidence tooltips.
  - Details pane: show list of recognized persons under description; allow manual resolve when empty/low confidence.
  - Keyboard UX: continue navigation after mark-complete; keep multi-select behaviors stable.
  - Share Links Manager: polish bulk generate UX feedback and error reporting.
- Events lifecycle
  - Ensure event delete handles large datasets without timeouts (chunk deletes, background job option).
  - Improve event switching notifications/refresh flows.
- Gallery
  - Pagination/cursor flow finalized; rebuild strategy after mutations; caching headers; preloading.
- Tests (at least 4 per step)
  - Face embeddings, recognition, and fusion correctness (fixture-based with tolerance).
  - Admin vs person-scope guards on new endpoints.
  - Stress tests: bulk uploads (2k), bulk zip download by tag, bulk share-link generate.
  - UI integration tests (smoke) for detection overlay and recognized list render.

## Current Issues (to address next)
- Health endpoint intermittently unreachable (curl shows 000) while dev logs print “API listening”
  - Likely caused by dev restarts (nodemon flapping) during requests; stabilize dev runner or run `node src/index.js` directly.
  - Add `backend/nodemon.json` (present) to ignore `uploads/`, `models/`, `.env` and reduce restarts.
  - Verify no long-running/hanging requests block Node’s event loop.
- Detect endpoint hangs for some images
  - Guard added: `DETECT_TIMEOUT_MS` (default 10s). If exceeded, returns 504 with empty items.
  - Continue to investigate hanging cases; add start/end logs with timings.
- SCRFD model compatibility and decoding
  - Errors with `scrfd_2.5g.onnx` (protobuf parsing failed). Recommended: `scrfd_2.5g_bnkps.onnx` or `scrfd_500m_bnkps.onnx` from InsightFace releases.
  - Current file in use: `scrfd_person_2.5g.onnx` (works to load, but returns 0 boxes). Output heads likely differ; naive “score/bbox” selection is insufficient.
  - Action: adapt post-processing to the model’s actual outputs (anchors/strides, per-head decoding), or use InsightFace JS binding for SCRFD.
- ONNX output shape warnings
  - ORT warns about expected vs actual shapes (e.g., {25,10} vs {20,10}). Indicates our assumptions on output heads are off; fix decoding.
- Tests pass but use minimal JPEG placeholder
  - `sharp` logs JPEG stream issues for tiny fixtures; OK for control, but add real test fixtures to validate detection pipeline.

## Environment & Configuration
- Backend env (backend/.env):
```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/photo_app
FRONTEND_ORIGIN=http://localhost:5173
OPENAI_API_KEY=...  # required for description/people endpoints
SCRFD_MODEL_PATH=models/scrfd_person_2.5g.onnx  # switch to scrfd_2.5g_bnkps.onnx or scrfd_500m_bnkps.onnx when available
DETECT_TIMEOUT_MS=8000
```
- Dev runner:
  - For stability: `node src/index.js`
  - Or: `npm run dev` (nodemon, may flap if watching uploads/models)

## Quick Commands
- Run backend dev
```
cd backend
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/photo_app"
export SCRFD_MODEL_PATH="models/scrfd_person_2.5g.onnx"
export DETECT_TIMEOUT_MS=8000
npm run dev
```
- Health check
```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4000/health
```
- Faces detect + list (replace PHOTO_ID)
```
curl -s -X POST http://localhost:4000/photos/3400/faces:detect
curl -s http://localhost:4000/photos/3400/faces
```
- Run tests (with targeted photo)
```
cd backend
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/photo_app"
export SCRFD_MODEL_PATH="models/scrfd_person_2.5g.onnx"
export TEST_PHOTO_ID=3400
npm test --silent | cat
```

## Implementation Notes & Next Steps
- Replace naive SCRFD output parsing with proper head decoding (per stride: 8/16/32), sigmoid activations, bbox decode, and NMS.
- Add ArcFace embedding extraction for each face; normalize and persist. Add OSNet embedding for appearance; fuse (e.g., weighted sum or learned scaler) and persist.
- Recognition endpoint: for each detection, find best tag by nearest neighbor over tag embeddings (with threshold); store `recognized_tag_id` and scores.
- Frontend: render recognized names in Details; manual resolve UI to accept/override suggestions.
- Performance: cache thumbnails, batch API calls, rate-limit heavy endpoints, and ensure DB indices exist for faces/person_embeddings.

## Troubleshooting
- Health 000 status
  - Ensure server actually running (`lsof -iTCP:4000 -sTCP:LISTEN`). Try `node src/index.js` instead of nodemon.
  - Unset proxies: `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy`.
- SCRFD model errors
  - Verify file path and permissions; prefer `scrfd_2.5g_bnkps.onnx` or `scrfd_500m_bnkps.onnx`.
  - Confirm ONNX opset compatibility with installed `onnxruntime-node`.
- Detect returns 0 results
  - Try a portrait image with large faces; lower threshold; verify decoding; test alternative SCRFD model.
