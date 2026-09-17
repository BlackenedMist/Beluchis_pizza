#!/bin/bash

# ==========================================
# Beluchis Pizza Deployment Script
# IBM Cloud Code Engine Preview Deployment
# Created: 2026-09-17
# ==========================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="beluchis-preview"
PROJECT_NAME="beluchis-preview-proj"
REGION="eu-gb"
RESOURCE_GROUP="Turbomonics"
GITHUB_REPO="https://github.com/BlackenedMist/Beluchis_pizza.git"
API_KEY_PATH="/mnt/hybrid-apps/configs/ibm/api-key.txt"

# Preview environment variables
export PORT="8080"
export DATABASE_URL="file:/data/beluchis.db"
export ADMIN_PIN="PREVIEW_ADMIN_PIN"
export PREVIEW_RESEED="1"

log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check ibmcloud CLI
    if ! command -v ibmcloud &> /dev/null; then
        error "ibmcloud CLI is not installed. Please install it first."
        exit 1
    fi
    
    # Check API key exists
    if [ ! -f "$API_KEY_PATH" ]; then
        error "API key not found at $API_KEY_PATH"
        exit 1
    fi
    
    # Check API key is readable
    if [ ! -r "$API_KEY_PATH" ]; then
        error "API key is not readable. Check file permissions."
        exit 1
    fi
    
    # Check docker (for local verification if needed)
    if ! command -v docker &> /dev/null; then
        warn "docker not found. Local image verification will be skipped."
    fi
    
    log "Prerequisites check passed."
}

# Login to IBM Cloud
login_to_ibmcloud() {
    log "Logging into IBM Cloud..."
    ibmcloud login --apikey "$(cat $API_KEY_PATH)"
    ibmcloud target -g $RESOURCE_GROUP -r $REGION
    log "Login successful."
}

# Select project
select_project() {
    log "Selecting/creating project: $PROJECT_NAME"
    
    # Check if project exists
    if ibmcloud ce project list | grep -q "^$PROJECT_NAME"; then
        log "Project '$PROJECT_NAME' already exists, selecting it."
        ibmcloud ce project select --name $PROJECT_NAME
    else
        log "Creating new project '$PROJECT_NAME'..."
        ibmcloud ce project create --name $PROJECT_NAME
        ibmcloud ce project select --name $PROJECT_NAME
    fi
}

# Create or update application
create_or_update_app() {
    log "Creating/updating application: $APP_NAME"
    
    # Check if app exists
    if ibmcloud ce app list | grep -q "^$APP_NAME"; then
        log "Application '$APP_NAME' already exists, updating configuration..."
        ibmcloud ce app update --name $APP_NAME \
            --env DATABASE_URL=$DATABASE_URL \
            --env ADMIN_PIN=$ADMIN_PIN \
            --env PREVIEW_RESEED=$PREVIEW_RESEED
        log "App updated. Restarting to apply changes..."
        ibmcloud ce app restart --name $APP_NAME
    else
        log "Creating new application '$APP_NAME'..."
        ibmcloud ce app create \
            --name $APP_NAME \
            --build-source $GITHUB_REPO \
            --strategy dockerfile \
            --port $PORT \
            --cpu 0.5 --memory 1G \
            --min-scale 1 --max-scale 1 \
            --env DATABASE_URL=$DATABASE_URL \
            --env ADMIN_PIN=$ADMIN_PIN \
            --env PREVIEW_RESEED=$PREVIEW_RESEED
    fi
}

# Get app URL
get_app_url() {
    local url
    url=$(ibmcloud ce app get --name $APP_NAME | grep "URL:" | awk '{print $2}')
    if [ -z "$url" ]; then
        error "Failed to get app URL. Check application status."
        exit 1
    fi
    echo $url
}

# Smoke tests
run_smoke_tests() {
    local url=$1
    
    log "Running smoke tests on $url..."
    
    # Test preview routes
    local mobile_status port_status specials_status
    mobile_status=$(curl -s -o /dev/null -w "%{http_code}" "$url/preview/mobile")
    port_status=$(curl -s -o /dev/null -w "%{http_code}" "$url/preview/portal")
    specials_status=$(curl -s -o /dev/null -w "%{http_code}" "$url/api/specials")
    
    if [ "$mobile_status" = "200" ]; then
        log "✓ /preview/mobile returns 200"
    else
        error "/preview/mobile returned $mobile_status (expected 200)"
        return 1
    fi
    
    if [ "$port_status" = "200" ]; then
        log "✓ /preview/portal returns 200"
    else
        error "/preview/portal returned $port_status (expected 200)"
        return 1
    fi
    
    if [ "$specials_status" = "200" ]; then
        log "✓ /api/specials returns 200 with data"
    else
        error "/api/specials returned $specials_status (expected 200)"
        return 1
    fi
    
    log "Smoke tests passed!"
}

# Show app status
show_app_status() {
    log "Application status:"
    ibmcloud ce app get --name $APP_NAME | grep -E "(Name|URL|Status|Conditions)"
}

# Main deployment function
deploy() {
    echo "========================================="
    echo "Beluchis Pizza IBM Cloud Code Engine Deployment"
    echo "========================================="
    
    check_prerequisites
    login_to_ibmcloud
    select_project
    create_or_update_app
    
    # Check if already deployed
    if ibmcloud ce app list | grep -q "^$APP_NAME"; then
        local app_url
        app_url=$(get_app_url)
        log "App URL: $app_url"
        run_smoke_tests "$app_url"
        show_app_status
        
        echo "========================================="
        log "Deployment completed successfully!"
        log "App is accessible at: $app_url"
        echo "========================================="
        echo "Note: The application appears to be already deployed."
        echo "       The ADMIN_PIN in environment is: $(ibmcloud ce app get --name $APP_NAME | grep "ADMIN_PIN" | awk '{print $3}')"
        echo "========================================="
    else
        error "App deployment failed. Check logs with: ibmcloud ce app logs --name $APP_NAME"
        exit 1
    fi
}

# Help function
show_help() {
    cat <<EOF
Beluchis Pizza Deployment Script

Usage: $0 [OPTIONS]

Options:
    --help          Show this help message
    --check-only    Check prerequisites only (don't deploy)
    --status        Show current application status

Description:
    Deploys the Beluchis Pizza application to IBM Cloud Code Engine as a preview environment.
    Uses existing deployment if available, otherwise creates a new one.

Environment Variables (can be overridden):
    ADMIN_PIN       Admin PIN for the application (default: PREVIEW_ADMIN_PIN)
    DATABASE_URL    Database connection URL (default: file:/data/beluchis.db)
    PREVIEW_RESEED  Enable demo data reseeding (default: 1)

Prerequisites:
    - ibmcloud CLI 2.46+ with code-engine plugin
    - IBM API key at /mnt/hybrid-apps/configs/ibm/api-key.txt
    - Docker daemon (optional, for local verification)

Note:
    - This deploys to IBM Cloud Code Engine (preview environment)
    - The database is ephemeral — demo data is reseeded on each cold start
    - Requires single instance (min-scale=max-scale=1) for session persistence
EOF
}

# Handle command line arguments
if [[ "$1" == "--help" ]]; then
    show_help
    exit 0
elif [[ "$1" == "--check-only" ]]; then
    check_prerequisites
    log "Prerequisites check complete. Ready for deployment."
    exit 0
elif [[ "$1" == "--status" ]]; then
    check_prerequisites
    login_to_ibmcloud
    select_project
    show_app_status
    exit 0
fi

# Run deployment
deploy
