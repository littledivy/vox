#!/bin/bash
set -e
PORT=8090
VENV=/tmp/dia-venv
LOG=/tmp/orpheus-server.log

case "${1:-start}" in
  stop) pkill -f "orpheus-local-server" 2>/dev/null && echo "stopped" || echo "not running" ;;
  status) curl -sf http://localhost:$PORT/health 2>/dev/null && echo "" || echo "not running" ;;
  logs) tail -f $LOG ;;
  start)
    pkill -f "orpheus-local-server\|csm-local-server\|dia-local-server\|server.py.*8090" 2>/dev/null || true
    sleep 1
    source $VENV/bin/activate
    echo "Starting Orpheus server on :$PORT..."
    python "$(dirname "$0")/orpheus-local-server.py" > $LOG 2>&1 &
    for i in $(seq 1 60); do
      sleep 1
      if curl -sf http://localhost:$PORT/health >/dev/null 2>&1; then
        echo "Orpheus server running (pid=$!)"
        echo "  Health:  http://localhost:$PORT/health"
        echo "  Stream:  POST http://localhost:$PORT/v1/tts/stream"
        echo "  Logs:    ./orpheus-server.sh logs"
        echo "  Stop:    ./orpheus-server.sh stop"
        exit 0
      fi
    done
    echo "Failed. Check: tail $LOG"
    exit 1 ;;
  *) echo "Usage: $0 [start|stop|status|logs]" ;;
esac
