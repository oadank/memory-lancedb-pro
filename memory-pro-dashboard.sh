#!/bin/bash
export NODE_PATH=/opt/openclaw/extensions/memory-lancedb-pro/node_modules
export DB_PATH=/root/.openclaw/memory/lancedb-pro
export PORT=1888
export HOST=0.0.0.0
cd /opt/openclaw/extensions/memory-lancedb-pro
exec node dashboard-server.cjs
