#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")/backend"
source venv/bin/activate
echo "Starting MambaRUL Studio backend on http://localhost:8000"
echo "API docs: http://localhost:8000/api/docs"
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
