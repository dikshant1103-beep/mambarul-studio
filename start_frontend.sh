#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")/frontend"
echo "Starting MambaRUL Studio frontend on http://localhost:5173"
npm run dev
