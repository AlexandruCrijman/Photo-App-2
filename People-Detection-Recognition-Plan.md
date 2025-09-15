# Photo Classification Album with AI – TODO and Current Issues

## Overview
Monolithic app (React + Vite frontend, Node/Express backend, PostgreSQL DB) with AI features for description, secure share links, and people detection/recognition (SCRFD + ArcFace + OSNet).

## Objective
Deliver a production-ready “People detection and recognition” feature that can reliably find all people in wedding-scale photos (crowded scenes), render non-destructive overlays in the preview, and recognize individuals by comparing detections against event-scoped tags. The system must:
- Handle 1.8k+ images efficiently (batch uploads, pagination, caching, and incremental builds).
- Use open-source models locally (SCRFD + ArcFace + OSNet) to minimize cost and avoid external dependencies, with optional GPT-5 flows for descriptions and structured insights.
- Preserve safety and scope separation (events; secure personal links) while remaining responsive under heavy user interactions.

## Remaining TODOs
- Step 1: DB models (completed)
  - Add `faces` with bbox, landmarks, orientation (yaw/pitch/roll), embeddings, confidence, recognized tag, timestamps.
  - Add `person_embeddings` for durable per-tag vectors; link to the `faces` row where the vector originated.
  - Create indices for query performance; enforce event scoping.

- Step 2: Detect endpoint and persistence (completed)
  - Endpoint `POST /photos/:photoId/faces:detect` to run detection and store results in `faces`.
  - Adds server-side timeout (`DETECT_TIMEOUT_MS`) to prevent hanging requests.
  - Health checks and tests for 404s, permissions, and person-scope guards.

- Step 3: Overlay UI (in progress)
  - Frontend canvas overlay draws red rectangles over preview without altering the source image.
  - Scale/position correctly against the preview’s rendered dimensions; redraw on resize/selection.
  - Enhance with hover states (thicker stroke or subtle glow), confidences, and toggle visibility.

- Step 4: Recognition + fusion (pending)
  - Extract ArcFace embeddings per detected face; extract OSNet appearance embeddings; compute a fused similarity.
  - Recognition endpoint assigns `recognized_tag_id` where similarity passes tuned thresholds; persist fused score.
  - Add rebuild job to update `person_embeddings` when tags/photos change (new photos strengthen the tag’s representation).

- Step 5: Gallery rebuild and maintenance (pending)
  - Cursor-based pagination finalized; efficient rebuild after mutations (upload/delete/retag/recognize).
  - Client preloading and caching for smooth navigation; reduce reflows.

- Step 6: Details UI for recognized persons (pending)
  - Show recognized persons under description; link to tag filters; provide manual override controls.
  - Support multi-select “apply recognition” and quick resolve for low-confidence detections.

- Step 7: Tuning and performance QA (pending)
  - Tune thresholds per scene density; calibrate NMS per stride; cap faces per image (e.g., 150) with smart sampling.
  - Validate performance on 1.8k+ images; measure P95 latencies for detect/list/describe/recognize; size caches.

- Frontend polish (ongoing)
  - Keyboard UX continuity (mark-complete moves to next; selection consistency across arrows/shift/ctrl).
  - Share Links Manager UX—clear bulk results, copy/revoke feedback, skip-existing behavior messaging.

- Events lifecycle hardening (ongoing)
  - Chunked deletes for large events; background job option; progress UI and post-completion refresh.
  - Safer event switch with confirmation when there are unsaved changes.

- Tests (expand breadth and depth)
  - Face embeddings/recognition/fusion correctness; numeric tolerances; confusion-matrix summaries.
  - Stress tests: 2k uploads, mass ZIP by tag, bulk share-link generate; ensure DB integrity and timeouts are avoided.
  - UI smoke: overlay presence and hitbox alignment across viewport sizes; recognized list render and manual override.

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
- Health 000 status (requests hang, no status)
  - Confirm listener exists: `lsof -n -P -iTCP:4000 -sTCP:LISTEN` and `nc -vz 127.0.0.1 4000`.
  - Run server without nodemon: `node src/index.js` (nodemon can flap if watching large folders).
  - Unset proxies: `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy`.
  - Check for long-running handlers; add start/end logs around suspect endpoints; ensure every code path calls `res.json(...)` or `res.end()`.

- Detect endpoint hangs or never returns
  - Use client timeout to prove the socket hangs: `curl -m 10 -v -X POST ...`.
  - Server-side timeout: set `DETECT_TIMEOUT_MS` (e.g., 8000). On timeout expect HTTP 504 JSON response.
  - Add route-level logs to verify entry/exit and timing.

- SCRFD model errors (protobuf parsing / 0 boxes)
  - Prefer official `scrfd_2.5g_bnkps.onnx` or `scrfd_500m_bnkps.onnx` under `backend/models/`; set `SCRFD_MODEL_PATH` accordingly.
  - Ensure model and ORT versions are compatible; consider pinning `onnxruntime-node` if needed.
  - Replace naive output parsing with proper multi-head decode (per stride 8/16/32) and NMS; verify tensor names and shapes.

- Tests pass but don’t validate real images
  - Replace tiny placeholder JPEG with a real portrait fixture; assert count ≥ expected; compare bbox structure.
  - Add regression fixtures for crowded scenes to validate NMS and caps.
