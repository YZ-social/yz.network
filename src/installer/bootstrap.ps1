# YZ Network Community Node Installer - PowerShell Bootstrap Script
# Usage: irm https://yz.network/install.ps1 | iex

$ErrorActionPreference = "Stop"
$InstallerVersion = "1.0.0"
$InstallDir = "$env:USERPROFILE\.yz-network"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "          YZ Network - Community Node Installer v$InstallerVersion" -ForegroundColor White
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""

# Check Docker
Write-Host "Checking prerequisites..."
try {
    $dockerVersion = docker --version
    Write-Host "✅ Docker found: $dockerVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ Docker is required but not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Docker Desktop from:"
    Write-Host "  https://www.docker.com/products/docker-desktop"
    exit 1
}

# Check Docker daemon
try {
    docker info | Out-Null
    Write-Host "✅ Docker daemon is running" -ForegroundColor Green
} catch {
    Write-Host "❌ Docker daemon is not running. Please start Docker Desktop." -ForegroundColor Red
    exit 1
}

Write-Host ""

# Create install directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}
Set-Location $InstallDir

# Detect external IP
Write-Host "🌐 Detecting external IP address..."
try {
    $ExternalIP = (Invoke-WebRequest -Uri "https://api.ipify.org" -UseBasicParsing -TimeoutSec 5).Content.Trim()
    Write-Host "✅ External IP: $ExternalIP" -ForegroundColor Green
} catch {
    Write-Host "⚠️  Could not detect external IP" -ForegroundColor Yellow
    $ExternalIP = Read-Host "Enter your external IP address (or press Enter to skip)"
}

# Get node count
Write-Host ""
Write-Host "📊 Resource Usage Per Node:" -ForegroundColor Cyan
Write-Host "   CPU: 0.15 cores | RAM: 128 MB | Disk: 50 MB"
Write-Host ""
$NodeCount = Read-Host "How many nodes would you like to run? (1-10, default: 3)"
if ([string]::IsNullOrWhiteSpace($NodeCount)) { $NodeCount = 3 }
$NodeCount = [int]$NodeCount
if ($NodeCount -lt 1 -or $NodeCount -gt 15) {
    Write-Host "Invalid node count, using default: 3" -ForegroundColor Yellow
    $NodeCount = 3
}
Write-Host "✅ Will deploy $NodeCount node(s)" -ForegroundColor Green

# Ask about UPnP
Write-Host ""
$UpnpChoice = Read-Host "Enable UPnP port forwarding? (Y/n)"
$UpnpEnabled = "true"
if ($UpnpChoice -match "^[Nn]") {
    $UpnpEnabled = "false"
    Write-Host "⚠️  UPnP disabled - manually forward ports 8100-$($8100 + $NodeCount - 1)" -ForegroundColor Yellow
}

# Dashboard not yet available - disabled for now
$IncludeDashboard = $false
# Write-Host ""
# $DashboardChoice = Read-Host "Include monitoring dashboard? (y/N)"
# if ($DashboardChoice -match "^[Yy]") {
#     $IncludeDashboard = $true
# }

# Generate docker-compose.yml
Write-Host ""
Write-Host "📝 Generating configuration..."

$BasePort = 8100
$BootstrapUrl = "ws://bootstrap.yz.network:8080"

$ComposeContent = @"
version: '3.8'

services:
"@

# Add node services
for ($i = 1; $i -le $NodeCount; $i++) {
    $Port = $BasePort + $i - 1
    $MetricsPort = 9090 + $i - 1

    if ($ExternalIP) {
        $PublicAddress = "ws://${ExternalIP}:${Port}"
    } else {
        $PublicAddress = "ws://localhost:${Port}"
    }

    $ComposeContent += @"

  dht-node-${i}:
    image: itsmeront/yz-dht-node:latest
    container_name: yz-community-node-${i}
    ports:
      - "${Port}:${Port}"
      - "${MetricsPort}:9090"
    environment:
      - BOOTSTRAP_URL=${BootstrapUrl}
      - NODE_NAME=community-node-${i}
      - OPEN_NETWORK=true
      - WEBSOCKET_PORT=${Port}
      - WEBSOCKET_HOST=0.0.0.0
      - PUBLIC_ADDRESS=${PublicAddress}
      - UPNP_ENABLED=${UpnpEnabled}
      - METRICS_PORT=9090
    networks:
      - dht-network
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '0.25'
          memory: 192M
"@
}

# Add dashboard if requested
if ($IncludeDashboard) {
    $ComposeContent += @"

  dashboard:
    image: itsmeront/yz-dashboard:latest
    container_name: yz-community-dashboard
    ports:
      - "3001:3000"
    environment:
      - METRICS_SCRAPE_INTERVAL=10000
    networks:
      - dht-network
    restart: unless-stopped
"@
}

# Add network
$ComposeContent += @"


networks:
  dht-network:
    driver: bridge
"@

$ComposeContent | Out-File -FilePath "docker-compose.community.yml" -Encoding UTF8
Write-Host "✅ Configuration saved to: $InstallDir\docker-compose.community.yml" -ForegroundColor Green

# Pull images
Write-Host ""
Write-Host "📥 Pulling Docker images..."
try {
    docker pull itsmeront/yz-dht-node:latest
} catch {
    Write-Host "⚠️  Pre-built image not available, will build locally on first run" -ForegroundColor Yellow
}

if ($IncludeDashboard) {
    try {
        docker pull itsmeront/yz-dashboard:latest
    } catch {
        Write-Host "⚠️  Dashboard image not available" -ForegroundColor Yellow
    }
}

# Start nodes
Write-Host ""
$StartChoice = Read-Host "🚀 Start nodes now? (Y/n)"
if (-not ($StartChoice -match "^[Nn]")) {
    Write-Host "Starting $NodeCount community node(s)..."
    docker-compose -f docker-compose.community.yml up -d

    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "✅ YZ Network Community Nodes Started!" -ForegroundColor Green
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "📊 Node Status:" -ForegroundColor Cyan
    for ($i = 1; $i -le $NodeCount; $i++) {
        $Port = $BasePort + $i - 1
        $Metrics = 9090 + $i - 1
        Write-Host "   Node ${i}: http://localhost:${Metrics}/health"
    }
    if ($IncludeDashboard) {
        Write-Host ""
        Write-Host "📈 Dashboard: http://localhost:3001" -ForegroundColor Cyan
    }
    Write-Host ""
    Write-Host "🔧 Management Commands:" -ForegroundColor Cyan
    Write-Host "   View logs:    docker-compose -f $InstallDir\docker-compose.community.yml logs -f"
    Write-Host "   Stop nodes:   docker-compose -f $InstallDir\docker-compose.community.yml stop"
    Write-Host "   Start nodes:  docker-compose -f $InstallDir\docker-compose.community.yml start"
    Write-Host "   Remove all:   docker-compose -f $InstallDir\docker-compose.community.yml down"
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "Configuration saved. To start nodes later, run:"
    Write-Host "   docker-compose -f $InstallDir\docker-compose.community.yml up -d"
}

Write-Host "Thank you for contributing to the YZ Network! 🙏" -ForegroundColor Green
