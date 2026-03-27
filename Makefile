.PHONY: help dev-backend dev-frontend install clean

.DEFAULT_GOAL := help

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

dev-backend: ## Start backend (port 8001)
	@cd backend && . venv/bin/activate && uvicorn app.main:app --reload --host 0.0.0.0 --port 8001

dev-frontend: ## Start frontend (port 5173)
	@cd frontend && npm run dev

install: ## Install dependencies
	@cd backend && python3 -m venv venv && . venv/bin/activate && pip install -r requirements.txt
	@cd frontend && npm install

clean: ## Remove venv and node_modules
	@rm -rf backend/venv frontend/node_modules
