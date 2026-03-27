.PHONY: help dev dev-backend dev-frontend install clean

.DEFAULT_GOAL := help

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

dev: ## Start backend and frontend (requires tmux)
	@if command -v tmux >/dev/null 2>&1; then \
		tmux new-session -d -s velxio 'make dev-backend' \; split-window -h 'make dev-frontend' \; attach; \
	else \
		echo "Install tmux or run 'make dev-backend' and 'make dev-frontend' in separate terminals"; \
	fi

dev-backend: ## Start backend (port 8001)
	@cd backend && . venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8001

dev-frontend: ## Start frontend (port 5173)
	@cd frontend && npm run dev

install: ## Install dependencies
	@echo "Installing root dependencies (tsx, typescript for build scripts)..."
	@npm install
	@echo "Installing backend dependencies..."
	@cd backend && python3 -m venv venv && . venv/bin/activate && pip install -r requirements.txt
	@echo "Installing frontend dependencies..."
	@cd frontend && npm install
	@echo "✓ All dependencies installed"

clean: ## Remove venv and node_modules
	@rm -rf backend/venv frontend/node_modules node_modules
