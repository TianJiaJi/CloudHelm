#!/usr/bin/env sh
set -eu
printf '%s\n' 'CloudHelm local mode: http://localhost:5173'
( cd backend && python -m pip install -r requirements.txt && python -m uvicorn app.main:app --reload --port 8000 ) &
backend_pid=$!
trap 'kill "$backend_pid"' EXIT
( cd frontend && npm install && npm run dev -- --host 0.0.0.0 )
