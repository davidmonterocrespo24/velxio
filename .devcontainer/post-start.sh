#!/bin/bash
set -e

cd /workspaces/velxio

echo "==> Fixing ownership for mounted volumes..."
sudo chown -R vscode:vscode /workspaces/velxio/frontend/node_modules 2>/dev/null || true

echo "==> Syncing Python dependencies..."
(cd /workspaces/velxio/backend
source venv/bin/activate
pip install -q -r requirements.txt)

echo "==> Syncing frontend dependencies..."
cd /workspaces/velxio/frontend
HUSKY=0 npm install
