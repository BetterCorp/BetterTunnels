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
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
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
}

type tunnelConfig struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Prefix     string `json:"prefix,omitempty"`
	HostHeader string `json:"host_header,omitempty"`
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
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return nil
	}

	switch args[0] {
	case "login":
		return login()
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
		return startTunnel(cfg)
	case "up":
		raw, err := os.ReadFile(".bettertunnel.json")
		if err != nil {
			return err
		}
		var cfg fileConfig
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return err
		}
		for _, tunnel := range cfg.Tunnels {
			t := withDefaults(tunnel)
			go func() {
				if err := startTunnel(t); err != nil {
					fmt.Fprintln(os.Stderr, err)
				}
			}()
		}
		select {}
	case "host":
		if len(args) >= 2 && args[1] == "--dev" {
			if len(args) < 4 {
				return errors.New("usage: btunnel host --dev <port> <command...>")
			}
			port, err := strconv.Atoi(args[2])
			if err != nil {
				return err
			}
			cmd := shellCommand(strings.Join(args[3:], " "))
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
		if len(args) < 2 {
			return errors.New("usage: btunnel host <dir> [port]")
		}
		port := 4173
		if len(args) > 2 {
			p, err := strconv.Atoi(args[2])
			if err != nil {
				return err
			}
			port = p
		}
		if err := serveStatic(args[1], port); err != nil {
			return err
		}
		return startTunnel(tunnelConfig{Host: "127.0.0.1", Port: port})
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
		code, retry := connectTunnel(context.Background(), u.String(), serverURL, config)
		if !retry || code == int(websocket.StatusProtocolError) || code == int(websocket.StatusPolicyViolation) {
			return nil
		}
		attempt++
		delay := retryDelay(attempt)
		fmt.Printf("Reconnecting %s:%d in %s...\n", config.Host, config.Port, delay/time.Second*time.Second)
		time.Sleep(delay)
	}
}

func connectTunnel(ctx context.Context, wsURL, serverURL string, config tunnelConfig) (int, bool) {
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Tunnel socket error for %s:%d: %v\n", config.Host, config.Port, err)
		return 0, true
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
			fmt.Printf("Tunnel closed for %s:%d: code=%d reason=%s\n", config.Host, config.Port, code, closeReason(err))
			return code, true
		}

		var f frame
		if err := json.Unmarshal(data, &f); err != nil {
			fmt.Fprintf(os.Stderr, "Tunnel protocol error for %s:%d: %v\n", config.Host, config.Port, err)
			_ = conn.Close(websocket.StatusProtocolError, "protocol error")
			close(closed)
			return int(websocket.StatusProtocolError), false
		}

		switch {
		case f.Type == "tunnel.ready":
			if maybeAutoUpdate(f.ServerVersion) {
				_ = conn.Close(websocket.StatusGoingAway, "cli updated")
				close(closed)
				os.Exit(0)
			}
			fmt.Println("Tunnel active")
			fmt.Printf("Local:  http://%s:%d\n", config.Host, config.Port)
			fmt.Printf("Public: %s\n", f.PublicURL)
			fmt.Printf("TTL:    %s\n", f.ExpiresAt)
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

func serveStatic(root string, port int) error {
	base, err := filepath.Abs(root)
	if err != nil {
		return err
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
	go func() {
		err := http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", port), handler)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	fmt.Printf("Static: http://127.0.0.1:%d\n", port)
	return nil
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

func retryDelay(attempt int) time.Duration {
	delays := []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second}
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
	fmt.Println("usage: btunnel version")
	fmt.Println("usage: btunnel update [version]")
	fmt.Println("usage: btunnel http <port|host:port>")
	fmt.Println("       btunnel host <dir> [port]")
	fmt.Println("       btunnel host --dev <port> <command...>")
	fmt.Println("       btunnel up")
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
	Message       string `json:"message,omitempty"`
}

func login() error {
	base := clientHTTPBase()
	startURL := base + "/api/client/auth/start"
	resp, err := http.Post(startURL, "application/json", strings.NewReader(`{}`))
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

func maybeAutoUpdate(serverVersion string) bool {
	if !shouldUpdate(version, serverVersion) {
		return false
	}
	fmt.Printf("CLI update available: %s -> %s\n", versionLabel(version), versionLabel(serverVersion))
	updated, err := updateCLI(serverVersion)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Automatic CLI update failed: %v\n", err)
		fmt.Fprintln(os.Stderr, "Run `btunnel update` manually after this session.")
		return false
	}
	if updated {
		fmt.Println("BetterTunnels CLI updated. Restarting is required; exiting this session now.")
		return true
	}
	return false
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
	req.Header.Set("User-Agent", "BetterTunnels/"+versionLabel(version))
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
	current = normalizeVersion(current)
	server = normalizeVersion(server)
	if current == "" || server == "" || current == "dev" {
		return false
	}
	return compareVersions(server, current) > 0
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
