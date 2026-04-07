#!/bin/bash
set -e

# Get the workspace root
WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# Get current user dynamically
CURRENT_USER=$(whoami)

echo "==> Fixing ownership for mounted volumes..."
sudo chown -R "$CURRENT_USER:$CURRENT_USER" frontend/node_modules 2>/dev/null || true

echo "==> Syncing Python dependencies..."
(cd backend
source venv/bin/activate
pip install -q -r requirements.txt)

echo "==> Syncing frontend dependencies..."
cd frontend
HUSKY=0 npm install
