package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const defaultServer = "wss://connect.tunnels.betterportal.dev"
const githubRepo = "BetterCorp/BetterTunnels"

var sessionID = uuid()
var version = "dev"

type cliState struct {
	Token     string `json:"token,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	TenantID  string `json:"tenantId,omitempty"`
	Subject   string `json:"bpUserSubject,omitempty"`
	Email     string `json:"bpUserEmail,omitempty"`
}

type tunnelConfig struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Prefix     string `json:"prefix,omitempty"`
	Validation string `json:"validation,omitempty"`
	HostHeader string `json:"host_header,omitempty"`
	// Orchestration fields, used by `btunnel up` entries only.
	Name         string `json:"name,omitempty"`
	Run          string `json:"run,omitempty"`
	Cwd          string `json:"cwd,omitempty"`
	Dir          string `json:"dir,omitempty"`
	Health       string `json:"health,omitempty"`
	ReadyTimeout int    `json:"ready_timeout,omitempty"`
}

type fileConfig struct {
	Tunnels []tunnelConfig `json:"tunnels"`
}

type frame struct {
	Type                 string            `json:"type"`
	Code                 int               `json:"code,omitempty"`
	RequestID            string            `json:"requestId,omitempty"`
	Method               string            `json:"method,omitempty"`
	Status               int               `json:"status,omitempty"`
	Headers              map[string]string `json:"headers,omitempty"`
	Body                 string            `json:"body,omitempty"`
	Message              string            `json:"message,omitempty"`
	PublicServerID       string            `json:"publicServerId,omitempty"`
	PublicSocketID       string            `json:"publicSocketId,omitempty"`
	FrameType            string            `json:"frameType,omitempty"`
	Path                 string            `json:"path,omitempty"`
	PublicURL            string            `json:"publicUrl,omitempty"`
	ExpiresAt            string            `json:"expiresAt,omitempty"`
	ServerVersion        string            `json:"serverVersion,omitempty"`
	OriginMs             *float64          `json:"originMs,omitempty"`
	Validation           string            `json:"validation,omitempty"`
	CLIOverheadMs        *float64          `json:"cliOverheadMs,omitempty"`
	TotalMs              *float64          `json:"totalMs,omitempty"`
	ClientAPIRoundtripMs *float64          `json:"clientApiRoundtripMs,omitempty"`
	InternalServerMs     *float64          `json:"internalServerMs,omitempty"`
}

type requestLog struct {
	method string
	path   string
	status int
}

type wsWriter struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (w *wsWriter) send(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.Write(ctx, websocket.MessageText, b)
}

func main() {
	loadDotEnv()
	checkStartupUpdate(os.Args[1:])
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func checkStartupUpdate(args []string) {
	if len(args) == 0 || (args[0] != "http" && args[0] != "host" && args[0] != "up") {
		return
	}
	serverVersion, err := checkHealth(clientHTTPBase())
	if err == nil {
		printUpdateNotice(serverVersion)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return nil
	}

	switch args[0] {
	case "help", "--help", "-h":
		help()
		return nil
	case "login":
		return login()
	case "logout":
		return logout()
	case "status":
		return status()
	case "version":
		fmt.Println(versionLabel(version))
		return nil
	case "update":
		target := "latest"
		if len(args) > 1 {
			target = args[1]
		}
		updated, err := updateCLI(target)
		if err != nil {
			return err
		}
		if updated {
			fmt.Println("BetterTunnels CLI updated. Restart your command to use the new version.")
		} else {
			fmt.Println("BetterTunnels CLI is already up to date.")
		}
		return nil
	case "http":
		if len(args) < 2 {
			return errors.New("usage: btunnel http <port|host:port>")
		}
		cfg, err := parseTarget(args[1])
		if err != nil {
			return err
		}
		for rest := args[2:]; len(rest) > 0; {
			validation, consumed, err := parseValidationFlag(rest)
			if err != nil {
				return err
			}
			if consumed == 0 {
				return fmt.Errorf("unknown flag %s", rest[0])
			}
			cfg.Validation = validation
			rest = rest[consumed:]
		}
		return startTunnel(cfg)
	case "up":
		raw, err := os.ReadFile(".bettertunnel.json")
		if err != nil {
			return err
		}
		raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
		var cfg fileConfig
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return err
		}
		if len(cfg.Tunnels) == 0 {
			return errors.New("no tunnels defined in .bettertunnel.json")
		}
		for i, t := range cfg.Tunnels {
			label := entryLabel(t, i)
			if t.Validation != "" && t.Validation != "cookie" && t.Validation != "ip" {
				return fmt.Errorf("tunnel %s: validation must be cookie or ip", label)
			}
			if t.Run != "" && t.Dir != "" {
				return fmt.Errorf("tunnel %s: run and dir are mutually exclusive", label)
			}
			if t.Dir == "" && t.Port == 0 {
				return fmt.Errorf("tunnel %s: port is required unless dir is set", label)
			}
			if t.Cwd != "" && t.Run == "" {
				return fmt.Errorf("tunnel %s: cwd requires run", label)
			}
		}
		var childMu sync.Mutex
		var children []*exec.Cmd
		var shuttingDown atomic.Bool
		killChildren := func() {
			shuttingDown.Store(true)
			childMu.Lock()
			defer childMu.Unlock()
			for _, c := range children {
				killTree(c)
			}
			children = nil
		}
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt)
		go func() {
			<-sig
			killChildren()
			os.Exit(0)
		}()
		for i := range cfg.Tunnels {
			t := withDefaults(cfg.Tunnels[i])
			label := entryLabel(t, i)
			if t.Dir != "" {
				t.Host = "127.0.0.1"
				p, err := serveStatic(t.Dir, t.Port)
				if err != nil {
					killChildren()
					return fmt.Errorf("tunnel %s: %w", label, err)
				}
				t.Port = p
			}
			if t.Run != "" {
				cmd := shellCommand(t.Run)
				cmd.Dir = t.Cwd
				cmd.Stdout = &lineWriter{prefix: label, out: os.Stdout}
				cmd.Stderr = &lineWriter{prefix: label, out: os.Stderr}
				fmt.Printf("[%s] starting: %s\n", label, t.Run)
				if err := cmd.Start(); err != nil {
					killChildren()
					return fmt.Errorf("tunnel %s: %w", label, err)
				}
				childMu.Lock()
				children = append(children, cmd)
				childMu.Unlock()
				go func(c *exec.Cmd, l string) {
					err := c.Wait()
					if shuttingDown.Load() {
						return
					}
					fmt.Fprintf(os.Stderr, "[%s] service exited: %v\n", l, err)
					killChildren()
					os.Exit(1)
				}(cmd, label)
			}
			needsReady := t.Run != "" || t.Health != ""
			go func(t tunnelConfig, l string, wait bool) {
				if wait {
					if err := waitReady(t, l); err != nil {
						fmt.Fprintln(os.Stderr, err)
						killChildren()
						os.Exit(1)
					}
				}
				if err := startTunnel(t); err != nil {
					fmt.Fprintln(os.Stderr, err)
				}
			}(t, label, needsReady)
		}
		select {}
	case "host":
		rest := args[1:]
		if len(rest) >= 1 && rest[0] == "--dev" {
			rest = rest[1:]
			port := 0
			for len(rest) > 0 && strings.HasPrefix(rest[0], "--") {
				p, consumed, err := parsePortFlag(rest)
				if err != nil {
					return err
				}
				if consumed == 0 {
					return fmt.Errorf("unknown flag %s", rest[0])
				}
				port = p
				rest = rest[consumed:]
			}
			if port == 0 || len(rest) == 0 {
				return errors.New("usage: btunnel host --dev --port <port> <command...>")
			}
			cmd := shellCommand(strings.Join(rest, " "))
			cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
			if err := cmd.Start(); err != nil {
				return err
			}
			go func() {
				_ = cmd.Wait()
				os.Exit(0)
			}()
			return startTunnel(tunnelConfig{Host: "127.0.0.1", Port: port})
		}
		port := 0
		dir := ""
		for i := 0; i < len(rest); i++ {
			if strings.HasPrefix(rest[i], "--") {
				p, consumed, err := parsePortFlag(rest[i:])
				if err != nil {
					return err
				}
				if consumed == 0 {
					return fmt.Errorf("unknown flag %s", rest[i])
				}
				port = p
				i += consumed - 1
				continue
			}
			if dir != "" {
				return errors.New("usage: btunnel host <dir> [--port <port>]")
			}
			dir = rest[i]
		}
		if dir == "" {
			return errors.New("usage: btunnel host <dir> [--port <port>]")
		}
		actualPort, err := serveStatic(dir, port)
		if err != nil {
			return err
		}
		return startTunnel(tunnelConfig{Host: "127.0.0.1", Port: actualPort})
	default:
		usage()
		return nil
	}
}

func startTunnel(config tunnelConfig) error {
	config = withDefaults(config)
	serverURL := os.Getenv("BETTER_TUNNELS_SERVER")
	if serverURL == "" {
		serverURL = defaultServer
	}
	u, err := url.Parse(serverURL)
	if err != nil {
		return err
	}
	u.Path = "/api/client/ws"
	q := u.Query()
	q.Set("sessionId", sessionID)
	q.Set("targetHost", config.Host)
	q.Set("targetPort", strconv.Itoa(config.Port))
	q.Set("clientVersion", version)
	if config.Validation != "" {
		q.Set("validation", config.Validation)
	}
	if config.Prefix != "" {
		q.Set("prefix", config.Prefix)
	}
	state, _ := loadState()
	if state.Token != "" {
		q.Set("authenticated", "true")
		q.Set("token", state.Token)
	}
	u.RawQuery = q.Encode()

	attempt := 0
	for {
		code, retry, ready := connectTunnel(context.Background(), u.String(), serverURL, config)
		if !retry || code == int(websocket.StatusProtocolError) || code == int(websocket.StatusPolicyViolation) {
			return nil
		}
		if ready {
			attempt = 0
		}
		attempt++
		delay := retryDelay(attempt)
		fmt.Printf("Reconnecting %s:%d in %s...\n", config.Host, config.Port, delay/time.Second*time.Second)
		time.Sleep(delay)
	}
}

func connectTunnel(ctx context.Context, wsURL, serverURL string, config tunnelConfig) (code int, retry bool, ready bool) {
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"User-Agent": {clientUserAgent()}},
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Tunnel server unreachable for %s:%d (server-side issue, your local service is fine): %v\n", config.Host, config.Port, err)
		return 0, true, false
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	writer := &wsWriter{conn: conn}
	originSockets := map[string]*websocket.Conn{}
	requests := map[string]requestLog{}
	var originMu sync.Mutex
	var requestsMu sync.Mutex
	closed := make(chan struct{})

	fmt.Printf("Connected: %s\n", serverURL)

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-closed:
				return
			case <-ticker.C:
				pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pingCtx)
				cancel()
				if err != nil {
					fmt.Printf("Tunnel heartbeat missed for %s:%d; reconnecting.\n", config.Host, config.Port)
					_ = conn.Close(websocket.StatusGoingAway, "heartbeat missed")
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			close(closed)
			originMu.Lock()
			for _, origin := range originSockets {
				_ = origin.Close(websocket.StatusNormalClosure, "")
			}
			originMu.Unlock()
			code := int(websocket.CloseStatus(err))
			fmt.Printf("Tunnel server connection lost for %s:%d (server-side, your local service is fine): code=%d reason=%s\n", config.Host, config.Port, code, closeReason(err))
			return code, true, ready
		}

		var f frame
		if err := json.Unmarshal(data, &f); err != nil {
			fmt.Fprintf(os.Stderr, "Tunnel protocol error for %s:%d: %v\n", config.Host, config.Port, err)
			_ = conn.Close(websocket.StatusProtocolError, "protocol error")
			close(closed)
			return int(websocket.StatusProtocolError), false, ready
		}

		switch {
		case f.Type == "tunnel.ready":
			ready = true
			fmt.Println("Tunnel active")
			fmt.Printf("Local:  http://%s:%d\n", config.Host, config.Port)
			fmt.Printf("Public: %s\n", f.PublicURL)
			fmt.Printf("TTL:    %s\n", f.ExpiresAt)
			if f.Validation != "" {
				fmt.Printf("Visitor auth: %s\n", f.Validation)
			}
			if f.ServerVersion != "" {
				fmt.Printf("Server: %s\n", versionLabel(f.ServerVersion))
			}
		case f.Type == "tunnel.closed":
			fmt.Printf("Tunnel closed by server: code=%d reason=%s\n", f.Code, f.Message)
			_ = conn.Close(websocket.StatusNormalClosure, "")
		case f.Type == "request.metrics" && f.RequestID != "":
			requestsMu.Lock()
			req, ok := requests[f.RequestID]
			delete(requests, f.RequestID)
			requestsMu.Unlock()
			label := f.RequestID
			if ok {
				label = fmt.Sprintf("%s %s -> %d", req.method, req.path, req.status)
			}
			fmt.Printf("%s total=%s tunnel=%s origin=%s cli=%s server=%s\n", label, fmtMs(f.TotalMs), fmtMs(f.ClientAPIRoundtripMs), fmtMs(f.OriginMs), fmtMs(f.CLIOverheadMs), fmtMs(f.InternalServerMs))
		case f.Type == "ws.toOrigin" && f.PublicServerID != "" && f.PublicSocketID != "" && f.FrameType != "":
			handleOriginWS(ctx, writer, &originMu, originSockets, config, f)
		case f.Type == "request.start" && f.RequestID != "":
			go handleRequest(ctx, writer, &requestsMu, requests, config, f)
		}
	}
}

func handleRequest(ctx context.Context, writer *wsWriter, mu *sync.Mutex, requests map[string]requestLog, config tunnelConfig, f frame) {
	started := time.Now()
	headers := map[string]string{}
	for k, v := range f.Headers {
		headers[k] = v
	}
	if config.HostHeader != "" {
		headers["host"] = config.HostHeader
	}
	resp, err := localRequest(config.Host, config.Port, f.Method, f.Path, headers, f.Body)
	if err != nil {
		_ = writer.send(ctx, frame{Type: "error", RequestID: f.RequestID, Message: err.Error()})
		return
	}
	cliOverhead := float64(time.Since(started).Milliseconds()) - resp.originMs
	if cliOverhead < 0 {
		cliOverhead = 0
	}
	_ = writer.send(ctx, frame{Type: "response.start", RequestID: f.RequestID, Status: resp.status, Headers: resp.headers})
	_ = writer.send(ctx, frame{Type: "response.body", RequestID: f.RequestID, Body: resp.body})
	_ = writer.send(ctx, frame{Type: "response.end", RequestID: f.RequestID, CLIOverheadMs: &cliOverhead, OriginMs: &resp.originMs})
	mu.Lock()
	requests[f.RequestID] = requestLog{method: f.Method, path: f.Path, status: resp.status}
	mu.Unlock()
}

type localResponse struct {
	status   int
	headers  map[string]string
	body     string
	originMs float64
}

func localRequest(host string, port int, method, path string, headers map[string]string, body string) (localResponse, error) {
	started := time.Now()
	if method == "" {
		method = "GET"
	}
	var reader io.Reader
	if body != "" {
		raw, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return localResponse{}, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, fmt.Sprintf("http://%s:%d%s", host, port, path), reader)
	if err != nil {
		return localResponse{}, err
	}
	for k, v := range headers {
		if strings.EqualFold(k, "host") {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return localResponse{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return localResponse{}, err
	}
	outHeaders := map[string]string{}
	for k, v := range resp.Header {
		outHeaders[k] = strings.Join(v, ", ")
	}
	return localResponse{
		status:   resp.StatusCode,
		headers:  outHeaders,
		body:     base64.StdEncoding.EncodeToString(raw),
		originMs: float64(time.Since(started).Milliseconds()),
	}, nil
}

func handleOriginWS(ctx context.Context, writer *wsWriter, mu *sync.Mutex, sockets map[string]*websocket.Conn, config tunnelConfig, f frame) {
	socketID := f.PublicSocketID
	if f.FrameType == "event" && f.Message == "open" {
		u := fmt.Sprintf("ws://%s:%d%s", config.Host, config.Port, defaultPath(f.Path))
		origin, _, err := websocket.Dial(ctx, u, nil)
		if err != nil {
			_ = writer.send(ctx, frame{Type: "ws.fromOrigin", PublicServerID: f.PublicServerID, PublicSocketID: socketID, FrameType: "event", Message: "close"})
			return
		}
		mu.Lock()
		sockets[socketID] = origin
		mu.Unlock()
		_ = writer.send(ctx, frame{Type: "ws.fromOrigin", PublicServerID: f.PublicServerID, PublicSocketID: socketID, FrameType: "ack"})
		go func() {
			defer func() {
				mu.Lock()
				delete(sockets, socketID)
				mu.Unlock()
				_ = origin.Close(websocket.StatusNormalClosure, "")
				_ = writer.send(ctx, frame{Type: "ws.fromOrigin", PublicServerID: f.PublicServerID, PublicSocketID: socketID, FrameType: "event", Message: "close"})
			}()
			for {
				_, data, err := origin.Read(ctx)
				if err != nil {
					return
				}
				_ = writer.send(ctx, frame{Type: "ws.fromOrigin", PublicServerID: f.PublicServerID, PublicSocketID: socketID, FrameType: "msg", Body: base64.StdEncoding.EncodeToString(data)})
			}
		}()
		return
	}
	mu.Lock()
	origin := sockets[socketID]
	mu.Unlock()
	if origin == nil {
		return
	}
	if f.FrameType == "msg" && f.Body != "" {
		raw, err := base64.StdEncoding.DecodeString(f.Body)
		if err == nil {
			_ = origin.Write(ctx, websocket.MessageBinary, raw)
		}
	}
	if f.FrameType == "event" && f.Message == "close" {
		_ = origin.Close(websocket.StatusNormalClosure, "")
	}
}

// parsePortFlag reads a leading --port <n> or --port=<n> from args.
// Returns consumed=0 when args[0] is not a port flag.
func parsePortFlag(args []string) (port int, consumed int, err error) {
	switch {
	case args[0] == "--port":
		if len(args) < 2 {
			return 0, 0, errors.New("--port requires a value")
		}
		p, err := strconv.Atoi(args[1])
		if err != nil || p < 1 || p > 65535 {
			return 0, 0, fmt.Errorf("invalid --port value: %s", args[1])
		}
		return p, 2, nil
	case strings.HasPrefix(args[0], "--port="):
		raw := strings.TrimPrefix(args[0], "--port=")
		p, err := strconv.Atoi(raw)
		if err != nil || p < 1 || p > 65535 {
			return 0, 0, fmt.Errorf("invalid --port value: %s", raw)
		}
		return p, 1, nil
	}
	return 0, 0, nil
}

func parseValidationFlag(args []string) (string, int, error) {
	value := ""
	consumed := 0
	switch {
	case args[0] == "--validation":
		if len(args) < 2 {
			return "", 0, errors.New("--validation requires a value")
		}
		value, consumed = args[1], 2
	case strings.HasPrefix(args[0], "--validation="):
		value, consumed = strings.TrimPrefix(args[0], "--validation="), 1
	default:
		return "", 0, nil
	}
	if value != "cookie" && value != "ip" {
		return "", 0, fmt.Errorf("invalid --validation value: %s (use cookie or ip)", value)
	}
	return value, consumed, nil
}

// serveStatic serves root on 127.0.0.1. port 0 picks a free port.
// Returns the port actually bound.
func serveStatic(root string, port int) (int, error) {
	base, err := filepath.Abs(root)
	if err != nil {
		return 0, err
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		file := filepath.Join(base, clean)
		rel, err := filepath.Rel(base, file)
		if err != nil || strings.HasPrefix(rel, "..") {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		info, err := os.Stat(file)
		if err == nil && info.IsDir() {
			file = filepath.Join(file, "index.html")
		}
		info, err = os.Stat(file)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if ct := mime.TypeByExtension(filepath.Ext(file)); ct != "" {
			w.Header().Set("content-type", ct)
		}
		http.ServeFile(w, r, file)
	})
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		if port == 0 {
			return 0, fmt.Errorf("cannot start local server: %w", err)
		}
		return 0, fmt.Errorf("cannot host on port %d: %w", port, err)
	}
	actual := ln.Addr().(*net.TCPAddr).Port
	go func() {
		if err := http.Serve(ln, handler); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	fmt.Printf("Static: http://127.0.0.1:%d\n", actual)
	return actual, nil
}

func parseTarget(target string) (tunnelConfig, error) {
	host := "127.0.0.1"
	portRaw := target
	if strings.Contains(target, ":") {
		parts := strings.Split(target, ":")
		host = strings.Join(parts[:len(parts)-1], ":")
		portRaw = parts[len(parts)-1]
	}
	port, err := strconv.Atoi(portRaw)
	if err != nil {
		return tunnelConfig{}, err
	}
	return tunnelConfig{Host: host, Port: port}, nil
}

func withDefaults(c tunnelConfig) tunnelConfig {
	if c.Host == "" {
		c.Host = "127.0.0.1"
	}
	return c
}

func shellCommand(command string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/C", command)
	}
	return exec.Command("sh", "-c", command)
}

func entryLabel(t tunnelConfig, i int) string {
	if t.Name != "" {
		return t.Name
	}
	if t.Dir != "" {
		return t.Dir
	}
	if t.Port != 0 {
		return fmt.Sprintf("%s:%d", withDefaults(t).Host, t.Port)
	}
	return fmt.Sprintf("tunnel[%d]", i)
}

// waitReady blocks until the target accepts a TCP connection, or when
// t.Health is set, until GET http://host:port<health> returns < 400.
func waitReady(t tunnelConfig, label string) error {
	timeout := time.Duration(t.ReadyTimeout) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	target := net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
	healthURL := ""
	if t.Health != "" {
		path := t.Health
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		healthURL = fmt.Sprintf("http://%s%s", target, path)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	for {
		if healthURL != "" {
			resp, err := client.Get(healthURL)
			if err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode < 400 {
					fmt.Printf("[%s] ready: %s -> %d\n", label, healthURL, resp.StatusCode)
					return nil
				}
			}
		} else {
			conn, err := net.DialTimeout("tcp", target, time.Second)
			if err == nil {
				_ = conn.Close()
				fmt.Printf("[%s] ready: tcp %s\n", label, target)
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("[%s] not ready after %s (%s)", label, timeout, target)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// killTree stops a child process including descendants spawned by its shell.
func killTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
		return
	}
	_ = cmd.Process.Kill()
}

// lineWriter prefixes each output line with the service label.
type lineWriter struct {
	mu     sync.Mutex
	prefix string
	out    io.Writer
	buf    []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(w.buf[:i]), "\r")
		fmt.Fprintf(w.out, "[%s] %s\n", w.prefix, line)
		w.buf = w.buf[i+1:]
	}
	return len(p), nil
}

func retryDelay(attempt int) time.Duration {
	delays := []time.Duration{time.Second, 2 * time.Second, 3 * time.Second, 5 * time.Second}
	if attempt < 1 {
		return delays[0]
	}
	if attempt > len(delays) {
		return delays[len(delays)-1]
	}
	return delays[attempt-1]
}

func fmtMs(v *float64) string {
	if v == nil {
		return "-"
	}
	return fmt.Sprintf("%.0fms", *v)
}

func defaultPath(path string) string {
	if path == "" {
		return "/"
	}
	return path
}

func closeReason(err error) string {
	if err == nil {
		return "none"
	}
	return err.Error()
}

func usage() {
	fmt.Println("usage: btunnel login")
	fmt.Println("usage: btunnel logout")
	fmt.Println("usage: btunnel status")
	fmt.Println("usage: btunnel version")
	fmt.Println("usage: btunnel update [version]")
	fmt.Println("usage: btunnel http <port|host:port>")
	fmt.Println("       btunnel http <port|host:port> [--validation cookie|ip]")
	fmt.Println("       btunnel host <dir> [--port <port>]")
	fmt.Println("       btunnel host --dev --port <port> <command...>")
	fmt.Println("       btunnel up")
	fmt.Println("       btunnel help")
}

func help() {
	usage()
	fmt.Println()
	fmt.Println("Examples:")
	fmt.Println("  btunnel login                  Authenticate in your browser")
	fmt.Println("  btunnel logout                 Clear the local auth token")
	fmt.Println("  btunnel status                 Check CLI, server, auth, and limits")
	fmt.Println("  btunnel http 3000              Expose localhost:3000")
	fmt.Println("  btunnel http 127.0.0.1:8080    Expose a specific local target")
	fmt.Println("  btunnel http 3000 --validation ip  Use IP + user-agent validation (authenticated only)")
	fmt.Println("  btunnel up                     Start tunnels from .bettertunnel.json")
	fmt.Println()
	fmt.Println("Authentication:")
	fmt.Println("  `login` stores a device token in the OS BetterTunnels config directory.")
	fmt.Println("  The server validates the token on every authenticated tunnel connection")
	fmt.Println("  for expiry, revocation, client IP range, and user-agent binding.")
	fmt.Println("  `status` validates the saved token without displaying its secret value.")
	fmt.Println("  Use `BETTER_TUNNELS_SERVER` to target a different API server.")
	fmt.Println()
	fmt.Println("Tunnel configuration (.bettertunnel.json):")
	fmt.Println("  {\"tunnels\":[{\"host\":\"127.0.0.1\",\"port\":3000,\"prefix\":\"web\"}]}")
	fmt.Println("  `prefix` is honored for authenticated tunnels and ignored for anonymous ones.")
	fmt.Println("  `validation` accepts `cookie` (default) or `ip` (authenticated only).")
	fmt.Println("  `host_header` overrides the Host header sent to the local service.")
	fmt.Println("  `run`, `cwd`, `dir`, `health`, and `ready_timeout` configure `btunnel up` services.")
	fmt.Println()
	fmt.Println("Validation and URLs:")
	fmt.Println("  Public URLs use the server's configured tunnel domain and generated prefix.")
	fmt.Println("  Anonymous visitors use the server verification flow before tunnel access.")
	fmt.Println("  Authenticated tunnels may set validation to `ip` in the CLI or config.")
	fmt.Println("  `ip` uses IP + user-agent validation without requiring a browser cookie.")
	fmt.Println("  Anonymous tunnels ignore this setting and always use cookie validation.")
	fmt.Println("  There is no unvalidated mode.")
}

type authStartResponse struct {
	SessionID  string `json:"sessionId"`
	PollSecret string `json:"pollSecret"`
	BrowserURL string `json:"browserUrl"`
	ExpiresAt  string `json:"expiresAt"`
}

type authStatusResponse struct {
	Status        string `json:"status"`
	Token         string `json:"token,omitempty"`
	ExpiresAt     string `json:"expiresAt,omitempty"`
	TenantID      string `json:"tenantId,omitempty"`
	BPUserSubject string `json:"bpUserSubject,omitempty"`
	BPUserEmail   string `json:"bpUserEmail,omitempty"`
	Message       string `json:"message,omitempty"`
}

type serviceStatusResponse struct {
	Status         string        `json:"status"`
	ServerVersion  string        `json:"serverVersion"`
	TenantID       string        `json:"tenantId,omitempty"`
	BPUserSubject  string        `json:"bpUserSubject,omitempty"`
	TokenExpiresAt string        `json:"tokenExpiresAt,omitempty"`
	Limits         serviceLimits `json:"limits"`
}

type serviceLimits struct {
	TunnelTTLHours     int  `json:"tunnelTtlHours"`
	RequestTimeoutSecs int  `json:"requestTimeoutSeconds"`
	IdleTimeoutSecs    int  `json:"idleTimeoutSeconds"`
	CustomPrefixes     bool `json:"customPrefixes"`
}

func status() error {
	state, stateErr := loadState()
	fmt.Printf("CLI\n  Version: %s\n", versionLabel(version))

	base := clientHTTPBase()
	serverVersion, err := checkHealth(base)
	if err != nil {
		fmt.Printf("Tunnel server\n  Status: unavailable (%v)\n", err)
	} else {
		fmt.Println("Tunnel server\n  Status: healthy")
		if serverVersion != "" {
			fmt.Printf("  Server version: %s\n", versionLabel(serverVersion))
			printUpdateNotice(serverVersion)
		}
	}

	if stateErr != nil || state.Token == "" {
		fmt.Println("Authentication\n  Status: not authenticated")
		printLimits(serviceLimits{TunnelTTLHours: 6, RequestTimeoutSecs: 60, IdleTimeoutSecs: 30})
		return nil
	}
	if state.ExpiresAt != "" {
		if expires, err := time.Parse(time.RFC3339, state.ExpiresAt); err == nil && !expires.After(time.Now()) {
			fmt.Printf("Authentication\n  Status: expired\n  User: %s\n", userLabel(state))
			printLimits(serviceLimits{TunnelTTLHours: 24, RequestTimeoutSecs: 300, IdleTimeoutSecs: 60, CustomPrefixes: true})
			return nil
		}
	}

	service, err := fetchServiceStatus(base, state.Token)
	if err != nil {
		fmt.Printf("Authentication\n  Status: unavailable (%v)\n  User: %s\n", err, userLabel(state))
		printLimits(serviceLimits{TunnelTTLHours: 24, RequestTimeoutSecs: 300, IdleTimeoutSecs: 60, CustomPrefixes: true})
		return nil
	}
	fmt.Printf("Authentication\n  Status: authenticated\n  User: %s\n  Tenant: %s\n  Token expires: %s\n", firstNonEmpty(state.Email, service.BPUserSubject, state.Subject), firstNonEmpty(service.TenantID, state.TenantID), firstNonEmpty(service.TokenExpiresAt, state.ExpiresAt))
	if service.ServerVersion != "" {
		fmt.Printf("  Server version: %s\n", versionLabel(service.ServerVersion))
	}
	printLimits(service.Limits)
	return nil
}

func printLimits(limits serviceLimits) {
	prefixes := "no"
	if limits.CustomPrefixes {
		prefixes = "yes"
	}
	fmt.Printf("Effective limits\n  Tunnel lifetime: %dh\n  Request timeout: %ds\n  Idle timeout: %ds\n  Custom prefixes: %s\n", limits.TunnelTTLHours, limits.RequestTimeoutSecs, limits.IdleTimeoutSecs, prefixes)
}

func checkHealth(base string) (string, error) {
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(base + "/health")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP %s", resp.Status)
	}
	return normalizeVersion(resp.Header.Get("X-BetterTunnels-Version")), nil
}

func printUpdateNotice(serverVersion string) {
	policy := updatePolicy(version, serverVersion)
	if policy.kind == updateNone {
		return
	}
	if policy.kind == updateRequired {
		fmt.Printf("CLI update required: %s -> %s. Run `btunnel update` before starting a tunnel.\n", versionLabel(version), versionLabel(serverVersion))
		return
	}
	fmt.Printf("CLI update available: %s -> %s. Run `btunnel update` when convenient.\n", versionLabel(version), versionLabel(serverVersion))
}

func fetchServiceStatus(base, token string) (serviceStatusResponse, error) {
	req, err := http.NewRequest("GET", base+"/api/client/status", nil)
	if err != nil {
		return serviceStatusResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", clientUserAgent())
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return serviceStatusResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return serviceStatusResponse{}, fmt.Errorf("HTTP %s", resp.Status)
	}
	if contentType := resp.Header.Get("Content-Type"); !strings.Contains(strings.ToLower(contentType), "json") {
		return serviceStatusResponse{}, fmt.Errorf("status endpoint returned %s; server may need its client service updated", firstNonEmpty(contentType, "non-JSON response"))
	}
	var status serviceStatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return serviceStatusResponse{}, err
	}
	return status, nil
}

func userLabel(state cliState) string {
	return firstNonEmpty(state.Email, state.Subject, "unknown")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return "unknown"
}

func logout() error {
	path, err := statePath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Println("BetterTunnels CLI logged out. Local auth token cleared.")
	return nil
}

func login() error {
	base := clientHTTPBase()
	startURL := base + "/api/client/auth/start"
	req, err := http.NewRequest("POST", startURL, strings.NewReader(`{}`))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", clientUserAgent())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("auth start failed: %s", strings.TrimSpace(string(raw)))
	}
	var started authStartResponse
	if err := json.NewDecoder(resp.Body).Decode(&started); err != nil {
		return err
	}

	fmt.Println("Open this URL to authenticate BetterTunnels:")
	fmt.Println(started.BrowserURL)
	_ = openBrowser(started.BrowserURL)

	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		status, err := pollAuthStatus(base, started.SessionID, started.PollSecret)
		if err != nil {
			return err
		}
		switch status.Status {
		case "pending":
			continue
		case "approved":
			if status.Token == "" {
				return errors.New("auth completed without token")
			}
			if err := saveState(cliState{
				Token:     status.Token,
				ExpiresAt: status.ExpiresAt,
				TenantID:  status.TenantID,
				Subject:   status.BPUserSubject,
				Email:     status.BPUserEmail,
			}); err != nil {
				return err
			}
			fmt.Println("BetterTunnels CLI authenticated.")
			return nil
		default:
			if status.Message != "" {
				return errors.New(status.Message)
			}
			return fmt.Errorf("auth failed: %s", status.Status)
		}
	}
	return errors.New("auth timed out")
}

func pollAuthStatus(base, sessionID, pollSecret string) (authStatusResponse, error) {
	req, err := http.NewRequest("GET", base+"/api/client/auth/status?sessionId="+url.QueryEscape(sessionID), nil)
	if err != nil {
		return authStatusResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+pollSecret)
	req.Header.Set("User-Agent", clientUserAgent())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return authStatusResponse{}, err
	}
	defer resp.Body.Close()
	var status authStatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return authStatusResponse{}, err
	}
	return status, nil
}

func clientHTTPBase() string {
	raw := os.Getenv("BETTER_TUNNELS_SERVER")
	if raw == "" {
		raw = defaultServer
	}
	u, err := url.Parse(raw)
	if err != nil {
		return strings.TrimRight(raw, "/")
	}
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	}
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/")
}

func statePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "BetterTunnels")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func loadState() (cliState, error) {
	path, err := statePath()
	if err != nil {
		return cliState{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cliState{}, err
	}
	var state cliState
	return state, json.Unmarshal(raw, &state)
}

func saveState(state cliState) error {
	path, err := statePath()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func openBrowser(rawURL string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL).Start()
	case "darwin":
		return exec.Command("open", rawURL).Start()
	default:
		return exec.Command("xdg-open", rawURL).Start()
	}
}

func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]), hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:16]))
}

func loadDotEnv() {
	raw, err := os.ReadFile(".env")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		key := strings.TrimSpace(parts[0])
		value := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
}

type updateKind int

const (
	updateNone updateKind = iota
	updateOptional
	updateRequired
)

type versionPolicy struct {
	kind   updateKind
	reason string
}

func updatePolicy(current, server string) versionPolicy {
	current = normalizeVersion(current)
	server = normalizeVersion(server)
	if current == "" || server == "" || current == "dev" {
		return versionPolicy{}
	}
	currentParts := versionParts(current)
	serverParts := versionParts(server)
	if compareVersions(server, current) <= 0 {
		return versionPolicy{}
	}
	if currentParts[0] != serverParts[0] {
		return versionPolicy{
			kind:   updateRequired,
			reason: fmt.Sprintf("Major versions differ (%d vs %d).", currentParts[0], serverParts[0]),
		}
	}
	minorDiff := serverParts[1] - currentParts[1]
	if minorDiff >= 2 {
		return versionPolicy{
			kind:   updateRequired,
			reason: fmt.Sprintf("Server is %d minor versions ahead.", minorDiff),
		}
	}
	return versionPolicy{kind: updateOptional}
}

func updateCLI(target string) (bool, error) {
	current := normalizeVersion(version)
	desired, err := resolveUpdateVersion(target)
	if err != nil {
		return false, err
	}
	if current != "dev" && current == desired {
		return false, nil
	}
	if current == "dev" && target != "latest" {
		fmt.Printf("Development CLI build will be replaced with %s.\n", versionLabel(desired))
	}

	exe, err := os.Executable()
	if err != nil {
		return false, err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return false, err
	}

	assetName := releaseAssetName()
	assetURL := fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", githubRepo, desired, assetName)
	checksumsURL := fmt.Sprintf("https://github.com/%s/releases/download/v%s/SHA256SUMS", githubRepo, desired)
	tempPath := filepath.Join(filepath.Dir(exe), fmt.Sprintf(".%s.%d.update", filepath.Base(exe), time.Now().UnixNano()))
	if runtime.GOOS == "windows" && !strings.HasSuffix(tempPath, ".exe") {
		tempPath += ".exe"
	}
	if err := downloadReleaseAsset(assetURL, tempPath); err != nil {
		_ = os.Remove(tempPath)
		return false, err
	}
	if err := verifyReleaseChecksum(checksumsURL, assetName, tempPath); err != nil {
		_ = os.Remove(tempPath)
		return false, err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tempPath, 0o755); err != nil {
			_ = os.Remove(tempPath)
			return false, err
		}
	}
	if err := installDownloadedUpdate(exe, tempPath); err != nil {
		_ = os.Remove(tempPath)
		return false, err
	}
	return true, nil
}

func resolveUpdateVersion(target string) (string, error) {
	target = strings.TrimSpace(target)
	if target == "" || target == "latest" {
		return latestGitHubVersion()
	}
	version := normalizeVersion(target)
	if version == "" || version == "dev" {
		return "", fmt.Errorf("invalid update version: %s", target)
	}
	return version, nil
}

func latestGitHubVersion() (string, error) {
	req, err := http.NewRequest("GET", "https://api.github.com/repos/"+githubRepo+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", clientUserAgent())
	client := http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("release lookup failed: %s %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	var out struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	resolved := normalizeVersion(out.TagName)
	if resolved == "" {
		return "", errors.New("latest release did not include a valid tag")
	}
	return resolved, nil
}

func downloadReleaseAsset(rawURL, path string) error {
	client := http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(rawURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return downloadFromReleaseArchive(rawURL, path)
	}
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("download failed: %s %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	out, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return err
}

func downloadFromReleaseArchive(assetURL, path string) error {
	archiveURL := archiveURLForAsset(assetURL)
	client := http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(archiveURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("download failed: %s %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	tmpArchive := path + ".zip"
	out, err := os.OpenFile(tmpArchive, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, resp.Body)
	closeErr := out.Close()
	defer os.Remove(tmpArchive)
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return extractAssetFromZip(tmpArchive, releaseAssetName(), path)
}

func archiveURLForAsset(assetURL string) string {
	parts := strings.Split(assetURL, "/")
	if len(parts) < 2 {
		return assetURL
	}
	tag := parts[len(parts)-2]
	return strings.Join(parts[:len(parts)-1], "/") + "/btunnel-" + tag + ".zip"
}

func extractAssetFromZip(zipPath, assetName, outputPath string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, file := range reader.File {
		if filepath.Base(file.Name) != assetName {
			continue
		}
		input, err := file.Open()
		if err != nil {
			return err
		}
		defer input.Close()
		out, err := os.OpenFile(outputPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, input)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	return fmt.Errorf("asset %s was not found in release archive", assetName)
}

func verifyReleaseChecksum(checksumsURL, assetName, path string) error {
	client := http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(checksumsURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("checksum lookup failed: %s %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	expected := checksumForAsset(string(raw), assetName)
	if expected == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("checksum mismatch for %s", assetName)
	}
	return nil
}

func checksumForAsset(raw, assetName string) string {
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if filepath.Base(fields[1]) == assetName {
			return fields[0]
		}
	}
	return ""
}

func installDownloadedUpdate(exe, tempPath string) error {
	if runtime.GOOS == "windows" {
		return installDownloadedUpdateWindows(exe, tempPath)
	}
	backup := exe + ".old"
	_ = os.Remove(backup)
	if err := os.Rename(exe, backup); err != nil {
		return err
	}
	if err := os.Rename(tempPath, exe); err != nil {
		_ = os.Rename(backup, exe)
		return err
	}
	_ = os.Remove(backup)
	return nil
}

func installDownloadedUpdateWindows(exe, tempPath string) error {
	script := tempPath + ".cmd"
	body := fmt.Sprintf("@echo off\r\nping 127.0.0.1 -n 3 > nul\r\nmove /Y %q %q > nul\r\ndel %%~f0\r\n", tempPath, exe)
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		return err
	}
	return exec.Command("cmd", "/C", "start", "", "/MIN", script).Start()
}

func releaseAssetName() string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("btunnel-%s-%s%s", runtime.GOOS, runtime.GOARCH, ext)
}

func shouldUpdate(current, server string) bool {
	return updatePolicy(current, server).kind != updateNone
}

func normalizeVersion(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "v")
	if value == "" {
		return ""
	}
	return value
}

func compareVersions(left, right string) int {
	leftParts := versionParts(left)
	rightParts := versionParts(right)
	for i := 0; i < 3; i++ {
		if leftParts[i] > rightParts[i] {
			return 1
		}
		if leftParts[i] < rightParts[i] {
			return -1
		}
	}
	return 0
}

func versionParts(value string) [3]int {
	value = normalizeVersion(value)
	var out [3]int
	parts := strings.Split(value, ".")
	for i := 0; i < len(parts) && i < len(out); i++ {
		part := parts[i]
		if idx := strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }); idx >= 0 {
			part = part[:idx]
		}
		n, _ := strconv.Atoi(part)
		out[i] = n
	}
	return out
}

func versionLabel(value string) string {
	value = normalizeVersion(value)
	if value == "" {
		return "unknown"
	}
	if value == "dev" {
		return value
	}
	return "v" + value
}

func clientUserAgent() string {
	return "BetterTunnels/" + versionLabel(version)
}
