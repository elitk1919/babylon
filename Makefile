COMPOSE = docker compose --project-directory . -f install/management_compose.yaml -f docker-compose.dev.yaml

.PHONY: up down build logs restart shell

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

build:
	$(COMPOSE) build admin

logs:
	$(COMPOSE) logs -f admin

restart:
	$(COMPOSE) restart admin

shell:
	$(COMPOSE) exec admin sh
