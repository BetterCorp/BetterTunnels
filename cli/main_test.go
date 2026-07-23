package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func TestLocalRequestStreamsBeforeOriginCompletes(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("data: one\n\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte("data: two\n\n"))
	}))
	defer server.Close()

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	host, portValue, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portValue)
	if err != nil {
		t.Fatal(err)
	}

	chunks := make(chan string, 2)
	done := make(chan error, 1)
	go func() {
		_, _, requestErr := localRequest(context.Background(), host, port, "GET", "/", nil, "",
			func(status int, headers map[string]string) error {
				if status != http.StatusOK || headers["Content-Type"] != "text/event-stream" {
					return fmt.Errorf("unexpected response start: status=%d headers=%v", status, headers)
				}
				return nil
			},
			func(body string) error {
				raw, decodeErr := base64.StdEncoding.DecodeString(body)
				if decodeErr == nil {
					chunks <- string(raw)
				}
				return decodeErr
			},
		)
		done <- requestErr
	}()

	select {
	case chunk := <-chunks:
		if chunk != "data: one\n\n" {
			close(release)
			t.Fatalf("unexpected first chunk %q", chunk)
		}
	case <-time.After(time.Second):
		close(release)
		t.Fatal("first SSE chunk was buffered until response completion")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestUpOptionsSelectPrefixAndProcesses(t *testing.T) {
	tunnels := []tunnelConfig{{Prefix: "api"}, {Prefix: "web"}}

	opts, err := parseUpOptions([]string{"web"})
	if err != nil {
		t.Fatal(err)
	}
	selected, err := selectUpEntries(tunnels, opts)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(selected, []int{1}) {
		t.Fatalf("selected %v, want [1]", selected)
	}

	opts, err = parseUpOptions([]string{"--proc"})
	if err != nil {
		t.Fatal(err)
	}
	selected, err = selectUpEntries(tunnels, opts)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(selected, []int{0, 1}) {
		t.Fatalf("selected %v, want [0 1]", selected)
	}
	if _, err := selectUpEntries(tunnels[:1], opts); err == nil {
		t.Fatal("--proc accepted fewer than two tunnels")
	}

	opts, err = parseUpOptions([]string{"--entry=1"})
	if err != nil {
		t.Fatal(err)
	}
	selected, err = selectUpEntries(tunnels, opts)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(selected, []int{1}) {
		t.Fatalf("selected %v, want [1]", selected)
	}
}

func TestSupervisorCloseStopsChild(t *testing.T) {
	parent, child := net.Pipe()
	stopped := make(chan struct{})
	go watchUpSupervisor(child, func() { close(stopped) })
	_ = parent.Close()

	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("child did not stop when its supervisor connection closed")
	}
}

func TestReauthPolicyClose(t *testing.T) {
	if !shouldReauthenticate(1008, "reauth required") {
		t.Fatal("reauth policy close was not recognized")
	}
	if shouldReauthenticate(1008, "tunnel expired") {
		t.Fatal("unrelated policy close triggered reauthentication")
	}
}
