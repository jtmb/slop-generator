#!/usr/bin/env bash
# =============================================================================
# Restart Agent Script - Stop and restart the slop-generator container
# =============================================================================

set -euo pipefail

# Configuration
CONTAINER_NAME="slop-generator"
COMPOSE_FILE="./docker-compose.yml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  log_error "docker-compose or docker compose not found. Please install Docker."
  exit 1
fi

# Determine compose command
if docker compose version &> /dev/null; then
  COMPOSE_CMD="docker compose -f ${COMPOSE_FILE}"
else
  COMPOSE_CMD="docker-compose -f ${COMPOSE_FILE}"
fi

# Check if container exists
if ! $COMPOSE_CMD ps | grep -q "${CONTAINER_NAME}"; then
  log_warn "Container '${CONTAINER_NAME}' is not running"
  log_info "Starting container..."
  
  # Validate .env file exists
  if [ ! -f "config/.env" ]; then
    log_error "config/.env file not found. Please copy config/.env.example to config/.env and configure it."
    exit 1
  fi
  
  $COMPOSE_CMD up -d
  log_info "Container started successfully"
else
  log_info "Container '${CONTAINER_NAME}' is already running"
fi

# Check container health
log_info "Waiting for container to be healthy..."
for i in {1..30}; do
  if $COMPOSE_CMD ps | grep -q "${CONTAINER_NAME}.*healthy"; then
    log_info "Container is healthy"
    exit 0
  fi
  
  sleep 2
done

log_warn "Container may not be fully ready yet"
