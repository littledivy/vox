package main

import (
	"context"
	"net"
	"time"

	"github.com/gorilla/websocket"
)

// ipv4WSDialer is a websocket dialer pinned to tcp4. Inside Docker Desktop IPv6
// has no route, so the default dialer's happy-eyeballs stalls ~6s on the AAAA
// record before falling back to IPv4. Used for Deepgram + Orpheus so TTS/STT
// connects instantly.
var ipv4WSDialer = &websocket.Dialer{
	HandshakeTimeout: 15 * time.Second,
	NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		return ipv4Dialer.DialContext(ctx, "tcp4", addr)
	},
}
