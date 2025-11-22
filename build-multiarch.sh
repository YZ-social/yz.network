#!/bin/bash
# Build and push multi-architecture Docker images for YZ Network
# Supports: linux/amd64, linux/arm64

set -e

echo "🏗️  Building multi-architecture Docker images for YZ Network"
echo ""

# Configuration
IMAGE_NAME="${1:-itsmeront/yz-dht-node}"
VERSION="${2:-latest}"
PLATFORMS="linux/amd64,linux/arm64"

echo "📦 Image: $IMAGE_NAME:$VERSION"
echo "🖥️  Platforms: $PLATFORMS"
echo ""

# Check if buildx is available
if ! docker buildx version &> /dev/null; then
    echo "❌ Docker buildx is not available. Please install Docker Desktop or enable buildx."
    exit 1
fi

# Create builder if it doesn't exist
if ! docker buildx inspect yz-builder &> /dev/null; then
    echo "🔧 Creating buildx builder..."
    docker buildx create --name yz-builder --use
else
    echo "✅ Using existing buildx builder"
    docker buildx use yz-builder
fi

# Bootstrap the builder
docker buildx inspect --bootstrap

echo ""
echo "🚀 Building and pushing multi-arch image..."
echo ""

# Build and push
docker buildx build \
  --platform $PLATFORMS \
  --file src/docker/Dockerfile.multiarch \
  --tag $IMAGE_NAME:$VERSION \
  --tag $IMAGE_NAME:$(date +%Y%m%d) \
  --push \
  .

echo ""
echo "✅ Multi-arch image built and pushed successfully!"
echo ""
echo "📋 To use this image:"
echo "   docker pull $IMAGE_NAME:$VERSION"
echo ""
echo "🖥️  Supported platforms:"
echo "   - linux/amd64 (x86_64)"
echo "   - linux/arm64 (ARM64/Ampere)"
