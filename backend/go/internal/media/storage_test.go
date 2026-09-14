package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestS3ProviderRoundTripAgainstCompatibleEndpoint(t *testing.T) {
	var (
		mu      sync.Mutex
		objects = map[string][]byte{}
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/bucket/")
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			data, _ := io.ReadAll(r.Body)
			objects[key] = data
			w.Header().Set("ETag", `"test-etag"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodHead:
			data, ok := objects[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Length", stringInt64(int64(len(data))))
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("ETag", `"test-etag"`)
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			data, ok := objects[key]
			if !ok {
				http.NotFound(w, r)
				return
			}
			start, end := 0, len(data)-1
			if raw := r.Header.Get("Range"); raw != "" {
				_, _ = fmtSscanfRange(raw, &start, &end)
				if start < 0 {
					start = 0
				}
				if end >= len(data) {
					end = len(data) - 1
				}
				w.WriteHeader(http.StatusPartialContent)
			}
			w.Header().Set("Content-Length", stringInt64(int64(end-start+1)))
			w.Header().Set("Content-Type", "image/jpeg")
			w.Header().Set("ETag", `"test-etag"`)
			_, _ = w.Write(data[start : end+1])
		case http.MethodDelete:
			delete(objects, key)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	config := map[string]any{
		"bucket":          "bucket",
		"region":          "us-east-1",
		"endpoint":        server.URL,
		"prefix":          "/photos",
		"accessKeyId":     "access",
		"secretAccessKey": "secret",
		"forcePathStyle":  true,
	}
	client, err := newS3Client(config)
	if err != nil {
		t.Fatal(err)
	}
	provider := &Provider{kind: "s3", config: config, s3: client}

	ctx := context.Background()
	body := []byte("chronoframe-s3")
	meta, err := provider.Put(ctx, "users/1/photo.jpg", bytes.NewReader(body), int64(len(body)), "image/jpeg")
	if err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if meta.Key != "photos/users/1/photo.jpg" {
		t.Fatalf("Put() key = %q", meta.Key)
	}
	data, gotMeta, err := provider.Get(ctx, "users/1/photo.jpg")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(data) != string(body) || gotMeta.ContentType != "image/jpeg" {
		t.Fatalf("Get() = %q, %#v", data, gotMeta)
	}
	rangeData, _, err := provider.Range(ctx, "users/1/photo.jpg", 0, 7)
	if err != nil || string(rangeData) != "chronofr" {
		t.Fatalf("Range() = %q, %v", rangeData, err)
	}
	if err := provider.Delete(ctx, "users/1/photo.jpg"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
}

func TestS3RangeFallsBackToClientSideSliceWhenEndpointIgnoresRange(t *testing.T) {
	body := []byte("chronoframe-s3-full-body")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Range") == "" {
			t.Errorf("Range header was not forwarded")
		}
		w.Header().Set("Content-Length", stringInt64(int64(len(body))))
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("ETag", `"test-etag"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer server.Close()

	config := map[string]any{
		"bucket":          "bucket",
		"region":          "us-east-1",
		"endpoint":        server.URL,
		"prefix":          "/photos",
		"accessKeyId":     "access",
		"secretAccessKey": "secret",
		"forcePathStyle":  true,
	}
	client, err := newS3Client(config)
	if err != nil {
		t.Fatal(err)
	}
	provider := &Provider{kind: "s3", config: config, s3: client}

	rangeData, meta, err := provider.Range(context.Background(), "users/1/photo.jpg", 1, 4)
	if err != nil {
		t.Fatalf("Range() error = %v", err)
	}
	if string(rangeData) != "hron" {
		t.Fatalf("Range() = %q, want %q", rangeData, "hron")
	}
	if meta.Size != int64(len(rangeData)) {
		t.Fatalf("Range() meta size = %d, want %d", meta.Size, len(rangeData))
	}
}

func TestS3SignedUploadURLMatchesNodeExternalUploadBehavior(t *testing.T) {
	config := map[string]any{
		"bucket":          "bucket",
		"region":          "us-east-1",
		"endpoint":        "https://s3.example.test",
		"prefix":          "/photos",
		"accessKeyId":     "access",
		"secretAccessKey": "secret",
		"forcePathStyle":  true,
	}
	client, err := newS3Client(config)
	if err != nil {
		t.Fatal(err)
	}
	provider := &Provider{kind: "s3", config: config, s3: client}

	signedURL, supported, err := provider.SignedUploadURL(context.Background(), "users/1/photo.jpg", 3600, "image/jpeg")
	if err != nil {
		t.Fatalf("SignedUploadURL() error = %v", err)
	}
	if !supported {
		t.Fatal("SignedUploadURL() supported = false, want true for non-COS S3")
	}
	if strings.HasPrefix(signedURL, "/api/photos/upload") {
		t.Fatalf("SignedUploadURL() = %q, want external presigned URL", signedURL)
	}

	parsed, err := url.Parse(signedURL)
	if err != nil {
		t.Fatalf("SignedUploadURL() returned invalid URL %q: %v", signedURL, err)
	}
	if parsed.Scheme != "https" || parsed.Host != "s3.example.test" {
		t.Fatalf("signed URL origin = %s://%s, want https://s3.example.test", parsed.Scheme, parsed.Host)
	}
	if parsed.Path != "/bucket/photos/users/1/photo.jpg" {
		t.Fatalf("signed URL path = %q, want bucket plus prefixed key", parsed.Path)
	}
	query := parsed.Query()
	if query.Get("X-Amz-Algorithm") == "" || query.Get("X-Amz-Signature") == "" {
		t.Fatalf("signed URL query = %v, want AWS presign parameters", query)
	}
	if signedHeaders := query.Get("X-Amz-SignedHeaders"); signedHeaders != "host" {
		t.Fatalf("X-Amz-SignedHeaders = %q, want Node-compatible host-only signed headers", signedHeaders)
	}
}

func TestS3SignedUploadURLFallsBackForTencentCOS(t *testing.T) {
	config := map[string]any{
		"bucket":          "bucket",
		"region":          "ap-shanghai",
		"endpoint":        "https://cos.ap-shanghai.myqcloud.com",
		"prefix":          "/photos",
		"accessKeyId":     "access",
		"secretAccessKey": "secret",
	}
	client, err := newS3Client(config)
	if err != nil {
		t.Fatal(err)
	}
	provider := &Provider{kind: "s3", config: config, s3: client}

	signedURL, supported, err := provider.SignedUploadURL(context.Background(), "users/1/photo.jpg", 3600, "image/jpeg")
	if err != nil {
		t.Fatalf("SignedUploadURL() error = %v", err)
	}
	if supported || signedURL != "" {
		t.Fatalf("SignedUploadURL() = %q, %v; want internal-upload fallback for Tencent COS", signedURL, supported)
	}
}

func TestSignedUploadURLUnsupportedForInternalUploadProviders(t *testing.T) {
	for _, provider := range []*Provider{
		{kind: "local", config: map[string]any{"prefix": "photos"}},
		{kind: "openlist", config: map[string]any{"rootPath": "/photos"}},
	} {
		signedURL, supported, err := provider.SignedUploadURL(context.Background(), "users/1/photo.jpg", 3600, "image/jpeg")
		if err != nil {
			t.Fatalf("%s SignedUploadURL() error = %v", provider.kind, err)
		}
		if supported || signedURL != "" {
			t.Fatalf("%s SignedUploadURL() = %q, %v; want unsupported internal-upload fallback", provider.kind, signedURL, supported)
		}
	}
}

func TestOpenListProviderRoundTrip(t *testing.T) {
	var (
		mu      sync.Mutex
		objects = map[string][]byte{}
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/api/fs/put":
			rawPath, _ := url.PathUnescape(r.Header.Get("File-Path"))
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			objects[strings.TrimLeft(rawPath, "/")] = body
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/api/fs/get":
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			key := strings.TrimLeft(payload["path"].(string), "/")
			mu.Lock()
			body, ok := objects[key]
			mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"size": len(body), "modified": time.Now().UTC().Format(time.RFC3339),
					"etag": "openlist-etag", "content_type": "image/jpeg",
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/download":
			key := r.URL.Query().Get("path")
			mu.Lock()
			body, ok := objects[key]
			mu.Unlock()
			if !ok {
				http.NotFound(w, r)
				return
			}
			if raw := r.Header.Get("Range"); raw != "" {
				start, end := 0, len(body)-1
				_, _ = fmtSscanfRange(raw, &start, &end)
				if end >= len(body) {
					end = len(body) - 1
				}
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write(body[start : end+1])
				return
			}
			_, _ = w.Write(body)
		case r.Method == http.MethodPost && r.URL.Path == "/api/fs/remove":
			var payload struct {
				Dir   string   `json:"dir"`
				Names []string `json:"names"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if len(payload.Names) > 0 {
				mu.Lock()
				delete(objects, strings.TrimLeft(strings.TrimRight(payload.Dir, "/")+"/"+payload.Names[0], "/"))
				mu.Unlock()
			}
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	provider := &Provider{
		kind: "openlist",
		config: map[string]any{
			"baseUrl": server.URL, "rootPath": "root", "token": "token",
			"uploadEndpoint": "/api/fs/put", "downloadEndpoint": "/download",
			"metaEndpoint": "/api/fs/get", "deleteEndpoint": "/api/fs/remove",
			"pathField": "path",
		},
	}
	body := []byte("openlist")
	if _, err := provider.Put(context.Background(), "users/1/photo.jpg",
		bytes.NewReader(body), int64(len(body)), "image/jpeg"); err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	data, _, err := provider.Get(context.Background(), "users/1/photo.jpg")
	if err != nil || string(data) != string(body) {
		t.Fatalf("Get() = %q, %v", data, err)
	}
	rangeData, _, err := provider.Range(context.Background(), "users/1/photo.jpg", 0, 3)
	if err != nil || string(rangeData) != "open" {
		t.Fatalf("Range() = %q, %v", rangeData, err)
	}
	if err := provider.Delete(context.Background(), "users/1/photo.jpg"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
}

func TestOpenListRangeFallsBackToClientSideSliceWhenEndpointIgnoresRange(t *testing.T) {
	body := []byte("openlist-full-body")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/fs/get":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"size": len(body), "modified": time.Now().UTC().Format(time.RFC3339),
					"etag": "openlist-etag", "content_type": "image/jpeg",
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/download":
			if r.Header.Get("Range") == "" {
				t.Errorf("Range header was not forwarded")
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	provider := &Provider{
		kind: "openlist",
		config: map[string]any{
			"baseUrl": server.URL, "rootPath": "root", "token": "token",
			"downloadEndpoint": "/download", "metaEndpoint": "/api/fs/get",
			"pathField": "path",
		},
	}
	rangeData, meta, err := provider.Range(context.Background(), "users/1/photo.jpg", 1, 4)
	if err != nil {
		t.Fatalf("Range() error = %v", err)
	}
	if string(rangeData) != "penl" {
		t.Fatalf("Range() = %q, want %q", rangeData, "penl")
	}
	if meta.Size != int64(len(rangeData)) {
		t.Fatalf("Range() meta size = %d, want %d", meta.Size, len(rangeData))
	}
}

func TestProviderReadAPIsRejectCanceledContext(t *testing.T) {
	provider := &Provider{
		kind: "local",
		config: map[string]any{
			"basePath": t.TempDir(),
		},
	}
	body := []byte("chronoframe-local")
	if _, err := provider.Put(context.Background(), "users/1/photo.jpg",
		bytes.NewReader(body), int64(len(body)), "image/jpeg"); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, _, err := provider.Get(ctx, "users/1/photo.jpg"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Get() error = %v, want context.Canceled", err)
	}
	if _, err := provider.Meta(ctx, "users/1/photo.jpg"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Meta() error = %v, want context.Canceled", err)
	}
	if _, _, err := provider.Range(ctx, "users/1/photo.jpg", 0, 4); !errors.Is(err, context.Canceled) {
		t.Fatalf("Range() error = %v, want context.Canceled", err)
	}
}

func TestContextReaderPropagatesCancellationAfterRead(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader := contextReader{
		ctx: ctx,
		reader: &cancelAfterFirstReadReader{
			data:   []byte("chronoframe"),
			cancel: cancel,
		},
	}

	buffer := make([]byte, 32)
	n, err := reader.Read(buffer)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Read() error = %v, want context.Canceled", err)
	}
	if string(buffer[:n]) != "chronoframe" {
		t.Fatalf("Read() bytes = %q, want chronoframe", buffer[:n])
	}
}

func TestWrapReaderContextPreservesSeeker(t *testing.T) {
	source := bytes.NewReader([]byte("chronoframe"))
	reader, ok := wrapReaderContext(context.Background(), source).(io.Seeker)
	if !ok {
		t.Fatal("wrapReaderContext() did not preserve io.Seeker")
	}
	position, err := reader.Seek(6, io.SeekStart)
	if err != nil {
		t.Fatalf("Seek() error = %v", err)
	}
	if position != 6 {
		t.Fatalf("Seek() position = %d, want 6", position)
	}
}

func TestLocalPutHonorsCanceledContextWithoutPublishingPartialObject(t *testing.T) {
	provider := &Provider{
		kind: "local",
		config: map[string]any{
			"basePath": t.TempDir(),
		},
	}
	key := "users/1/photo.jpg"
	original := []byte("chronoframe-original")
	if _, err := provider.Put(context.Background(), key,
		bytes.NewReader(original), int64(len(original)), "image/jpeg"); err != nil {
		t.Fatalf("initial Put() error = %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	replacement := []byte("chronoframe-replacement")
	_, err := provider.Put(ctx, key,
		&cancelAfterFirstReadReader{data: replacement, cancel: cancel},
		int64(len(replacement)), "image/jpeg")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("replacement Put() error = %v, want context.Canceled", err)
	}

	data, _, err := provider.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get() after canceled Put() error = %v", err)
	}
	if !bytes.Equal(data, original) {
		t.Fatalf("Get() after canceled Put() = %q, want original object %q", data, original)
	}
}

type cancelAfterFirstReadReader struct {
	data   []byte
	cancel context.CancelFunc
	done   bool
}

func (reader *cancelAfterFirstReadReader) Read(buffer []byte) (int, error) {
	if reader.done {
		return 0, io.EOF
	}
	reader.done = true
	n := copy(buffer, reader.data)
	reader.cancel()
	return n, nil
}

func stringInt64(value int64) string {
	return strconv.FormatInt(value, 10)
}

func fmtSscanfRange(value string, start *int, end *int) (int, error) {
	value = strings.TrimPrefix(value, "bytes=")
	_, err := fmt.Sscanf(value, "%d-%d", start, end)
	return 2, err
}
