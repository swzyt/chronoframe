package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/config"
	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
	"github.com/swzyt/chronoframe/backend/go/internal/queue"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
	"github.com/swzyt/chronoframe/backend/go/internal/storage"
)

const pipelineConsumerTestClaimToken = "test-claim-token"

func TestPipelineConsumerWaitsForRuntimeLeaseWhenHeld(t *testing.T) {
	oldRetryInterval := pipelineRuntimeLeaseRetryInterval
	pipelineRuntimeLeaseRetryInterval = time.Millisecond
	t.Cleanup(func() {
		pipelineRuntimeLeaseRetryInterval = oldRetryInterval
	})

	leaseStore := &retryRuntimeLeaseStore{acquireAfter: 2}
	application := NewApplication(Dependencies{
		Config: config.Config{Environment: "development"},
		Redis:  leaseStore,
	})
	consumer := NewPipelineConsumer(
		application,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		1,
		time.Second,
	)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	runContext, releaseLease, acquired := consumer.acquireRuntimeLease(ctx)
	if !acquired {
		t.Fatal("expected runtime lease to be acquired after retry")
	}
	if runContext == ctx {
		t.Fatal("expected acquired runtime lease to create a cancellable run context")
	}
	releaseLease()

	if got := leaseStore.Attempts(); got != 2 {
		t.Fatalf("lease acquire attempts = %d, want 2", got)
	}
	if !leaseStore.Released() {
		t.Fatal("expected runtime lease to be released")
	}
}

func TestPipelineConsumerStopsWaitingForRuntimeLeaseOnContextCancel(t *testing.T) {
	oldRetryInterval := pipelineRuntimeLeaseRetryInterval
	pipelineRuntimeLeaseRetryInterval = time.Millisecond
	t.Cleanup(func() {
		pipelineRuntimeLeaseRetryInterval = oldRetryInterval
	})

	leaseStore := &retryRuntimeLeaseStore{acquireAfter: 1_000}
	application := NewApplication(Dependencies{
		Config: config.Config{Environment: "development"},
		Redis:  leaseStore,
	})
	consumer := NewPipelineConsumer(
		application,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		1,
		time.Second,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	_, _, acquired := consumer.acquireRuntimeLease(ctx)
	if acquired {
		t.Fatal("expected runtime lease wait to stop without acquisition after context cancellation")
	}
	if got := leaseStore.Attempts(); got == 0 {
		t.Fatal("expected at least one lease acquire attempt")
	}
}

func TestPipelineConsumerDrainsClaimedTaskBeforeReleasingRuntimeLease(t *testing.T) {
	ctx := context.Background()
	store, err := platformdb.Open(ctx, filepath.Join(t.TempDir(), "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.SQL().Exec(`
		CREATE TABLE pipeline_queue (
			id INTEGER PRIMARY KEY,
			payload TEXT NOT NULL,
			priority INTEGER NOT NULL DEFAULT 0,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 3,
			status TEXT NOT NULL DEFAULT 'pending',
			status_stage TEXT,
			error_message TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			available_at INTEGER NOT NULL DEFAULT (unixepoch()),
			claimed_by TEXT,
			claim_token TEXT,
			claim_expires_at INTEGER,
			completed_at INTEGER,
			owner_user_id INTEGER NOT NULL
		);
		INSERT INTO pipeline_queue(id, payload, owner_user_id)
		VALUES(41, '{"type":"photo","storageKey":"drain-test.png"}', 1);
	`); err != nil {
		t.Fatal(err)
	}

	leaseStore := &retryRuntimeLeaseStore{acquireAfter: 1}
	application := NewApplication(Dependencies{
		Config: config.Config{Environment: "development"},
		Redis:  leaseStore,
		Queue:  queue.NewSQLiteRepository(store.SQL()),
	})
	consumer := NewPipelineConsumer(
		application,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		1,
		time.Hour,
	)
	taskStarted := make(chan context.Context, 1)
	finishTask := make(chan struct{})
	consumer.processTaskFn = func(taskContext context.Context, _ queue.Task) error {
		taskStarted <- taskContext
		select {
		case <-finishTask:
			return nil
		case <-taskContext.Done():
			return taskContext.Err()
		}
	}

	runContext, stop := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		consumer.Run(runContext)
	}()

	var taskContext context.Context
	select {
	case taskContext = <-taskStarted:
	case <-time.After(time.Second):
		t.Fatal("pipeline consumer did not claim the test task")
	}
	stop()

	select {
	case <-runDone:
		t.Fatal("pipeline consumer returned before the in-flight task drained")
	case <-time.After(25 * time.Millisecond):
	}
	select {
	case <-taskContext.Done():
		t.Fatalf("in-flight task context was canceled during graceful drain: %v", taskContext.Err())
	default:
	}
	if leaseStore.Released() {
		t.Fatal("runtime lease was released before the in-flight task drained")
	}

	close(finishTask)
	select {
	case <-runDone:
	case <-time.After(time.Second):
		t.Fatal("pipeline consumer did not finish after the task drained")
	}
	if !leaseStore.Released() {
		t.Fatal("runtime lease was not released after the in-flight task drained")
	}

	var status string
	var claimedBy, claimToken sql.NullString
	if err := store.SQL().QueryRow(`
		SELECT status, claimed_by, claim_token
		FROM pipeline_queue
		WHERE id = 41
	`).Scan(&status, &claimedBy, &claimToken); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || claimedBy.Valid || claimToken.Valid {
		t.Fatalf("drained task state = status:%q claimedBy:%v claimToken:%v", status, claimedBy, claimToken)
	}
}

func TestProcessLivePhotoVideoQueueTaskLinksExistingPhoto(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	store, err := platformdb.Open(ctx, filepath.Join(tempDir, "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	createPipelineConsumerAppSchema(t, store.SQL(), tempDir)

	videoKey := "uploads/IMG_0001.MOV"
	videoPath := filepath.Join(tempDir, "storage", filepath.FromSlash(videoKey))
	if err := os.MkdirAll(filepath.Dir(videoPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(videoPath, []byte("mov bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	application := NewApplication(Dependencies{
		Config:   config.Config{Environment: "development"},
		Logger:   slog.New(slog.NewTextHandler(os.Stderr, nil)),
		Database: store,
		Settings: settings.NewService(settings.NewSQLiteRepository(store.SQL())),
		Queue:    queue.NewSQLiteRepository(store.SQL()),
		Storage:  storage.NewSQLiteRepository(store.SQL()),
	})

	task := queue.Task{
		ID:      1,
		Payload: map[string]any{"type": "live-photo-video", "storageKey": videoKey},
	}
	if err := application.processLivePhotoVideoQueueTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	var isLivePhoto int64
	var livePhotoVideoURL, livePhotoVideoKey string
	if err := store.SQL().QueryRowContext(ctx, `
		SELECT is_live_photo, COALESCE(live_photo_video_url,''), COALESCE(live_photo_video_key,'')
		FROM photos
		WHERE id = 'photo-1'
	`).Scan(&isLivePhoto, &livePhotoVideoURL, &livePhotoVideoKey); err != nil {
		t.Fatal(err)
	}
	if isLivePhoto != 1 || livePhotoVideoURL != "/storage/"+videoKey || livePhotoVideoKey != videoKey {
		t.Fatalf("live photo fields = %d %q %q, want linked video", isLivePhoto, livePhotoVideoURL, livePhotoVideoKey)
	}
}

func TestProcessLivePhotoVideoQueueTaskCompletesWhenPhotoHasNotArrivedYet(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	store, err := platformdb.Open(ctx, filepath.Join(tempDir, "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	createPipelineConsumerAppSchema(t, store.SQL(), tempDir)

	videoKey := "uploads/NO_MATCH.MOV"
	videoPath := filepath.Join(tempDir, "storage", filepath.FromSlash(videoKey))
	if err := os.MkdirAll(filepath.Dir(videoPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(videoPath, []byte("mov bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	application := NewApplication(Dependencies{
		Config:   config.Config{Environment: "development"},
		Logger:   slog.New(slog.NewTextHandler(os.Stderr, nil)),
		Database: store,
		Settings: settings.NewService(settings.NewSQLiteRepository(store.SQL())),
		Queue:    queue.NewSQLiteRepository(store.SQL()),
		Storage:  storage.NewSQLiteRepository(store.SQL()),
	})

	task := queue.Task{
		ID:      1,
		Payload: map[string]any{"type": "live-photo-video", "storageKey": videoKey},
	}
	if err := application.processLivePhotoVideoQueueTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	var isLivePhoto int64
	if err := store.SQL().QueryRowContext(ctx, "SELECT is_live_photo FROM photos WHERE id = 'photo-1'").Scan(&isLivePhoto); err != nil {
		t.Fatal(err)
	}
	if isLivePhoto != 0 {
		t.Fatalf("is_live_photo = %d, want unchanged", isLivePhoto)
	}
}

func TestStripLocationExifRemovesNodeLocationKeysWithoutMutatingInput(t *testing.T) {
	input := map[string]any{
		"Make":            "Camera",
		"GPSLatitude":     31.2304,
		"GPSLongitude":    121.4737,
		"GPSDateStamp":    "2026:09:11",
		"GPSImgDirection": 90,
	}
	output := stripLocationExif(input)
	if output["Make"] != "Camera" {
		t.Fatalf("non-location EXIF was removed: %#v", output)
	}
	for _, key := range []string{"GPSLatitude", "GPSLongitude", "GPSDateStamp", "GPSImgDirection"} {
		if _, exists := output[key]; exists {
			t.Fatalf("location key %s still exists in %#v", key, output)
		}
		if _, exists := input[key]; !exists {
			t.Fatalf("input map was mutated, missing %s", key)
		}
	}
}

func TestFilterNeededExifDropsExifToolFileFields(t *testing.T) {
	output := filterNeededExif(map[string]any{
		"Directory":    "/tmp/chronoframe-exif",
		"FileName":     "source.JPG",
		"FileSize":     1234,
		"Make":         "Camera",
		"GPSLatitude":  31.2304,
		"UnknownExtra": true,
	})
	if output["Make"] != "Camera" || output["GPSLatitude"] != 31.2304 {
		t.Fatalf("needed EXIF fields missing from %#v", output)
	}
	for _, key := range []string{"Directory", "FileName", "FileSize", "UnknownExtra"} {
		if _, exists := output[key]; exists {
			t.Fatalf("file/internal EXIF key %s leaked into %#v", key, output)
		}
	}
}

func TestProcessPhotoReverseGeocodingQueueTaskUsesNominatimSettings(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	store, err := platformdb.Open(ctx, filepath.Join(tempDir, "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	createPipelineConsumerAppSchema(t, store.SQL(), tempDir)

	var seenPath, seenLatitude, seenLongitude, seenLanguage, seenUserAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenLatitude = r.URL.Query().Get("lat")
		seenLongitude = r.URL.Query().Get("lon")
		seenLanguage = r.URL.Query().Get("accept-language")
		seenUserAgent = r.Header.Get("User-Agent")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"display_name": "中国上海市浦东新区世纪大道",
			"address": map[string]any{
				"country":  "中国",
				"district": "浦东新区",
				"city":     "上海市",
			},
		})
	}))
	defer server.Close()

	insertPipelineConsumerSetting(t, store.SQL(), "location", "provider", "string", "nominatim")
	insertPipelineConsumerSetting(t, store.SQL(), "location", "language", "string", "zh-CN")
	insertPipelineConsumerSetting(t, store.SQL(), "location", "nominatim.baseUrl", "string", server.URL)
	insertPipelineConsumerTask(t, store.SQL(), 11)

	application := NewApplication(Dependencies{
		Config:   config.Config{Environment: "development"},
		Logger:   slog.New(slog.NewTextHandler(os.Stderr, nil)),
		Database: store,
		Settings: settings.NewService(settings.NewSQLiteRepository(store.SQL())),
		Queue:    queue.NewSQLiteRepository(store.SQL()),
		Storage:  storage.NewSQLiteRepository(store.SQL()),
	})

	task := queue.Task{
		ID:         11,
		ClaimToken: stringPtrForTest(pipelineConsumerTestClaimToken),
		Payload: map[string]any{
			"type":      "photo-reverse-geocoding",
			"photoId":   "photo-1",
			"latitude":  31.2304,
			"longitude": 121.4737,
		},
	}
	if err := application.processPhotoReverseGeocodingQueueTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	if seenPath != "/reverse" || seenLatitude != "31.2304" || seenLongitude != "121.4737" {
		t.Fatalf("nominatim request = path %q lat %q lon %q", seenPath, seenLatitude, seenLongitude)
	}
	if seenLanguage != "zh-Hans,zh-CN,en" {
		t.Fatalf("accept-language = %q, want zh-Hans,zh-CN,en", seenLanguage)
	}
	if seenUserAgent != "chronoframe/1.0" {
		t.Fatalf("User-Agent = %q, want chronoframe/1.0", seenUserAgent)
	}

	var (
		latitude     float64
		longitude    float64
		country      string
		city         string
		locationName string
		stage        string
	)
	if err := store.SQL().QueryRowContext(ctx, `
		SELECT latitude, longitude, country, city, location_name
		FROM photos
		WHERE id = 'photo-1'
	`).Scan(&latitude, &longitude, &country, &city, &locationName); err != nil {
		t.Fatal(err)
	}
	if latitude != 31.2304 || longitude != 121.4737 || country != "中国" || city != "浦东新区" || locationName != "中国上海市浦东新区世纪大道" {
		t.Fatalf("photo location = (%v,%v,%q,%q,%q)", latitude, longitude, country, city, locationName)
	}
	if err := store.SQL().QueryRowContext(ctx, "SELECT status_stage FROM pipeline_queue WHERE id = 11").Scan(&stage); err != nil {
		t.Fatal(err)
	}
	if stage != "reverse-geocoding" {
		t.Fatalf("status_stage = %q, want reverse-geocoding", stage)
	}
}

func TestProcessPhotoReverseGeocodingQueueTaskFallsBackToExifCoordinates(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	store, err := platformdb.Open(ctx, filepath.Join(tempDir, "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	createPipelineConsumerAppSchema(t, store.SQL(), tempDir)

	var seenLatitude, seenLongitude string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenLatitude = r.URL.Query().Get("lat")
		seenLongitude = r.URL.Query().Get("lon")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"display_name": "Southern Western Test Point",
			"address": map[string]any{
				"country_code": "nz",
				"city":         "Dunedin",
			},
		})
	}))
	defer server.Close()

	insertPipelineConsumerSetting(t, store.SQL(), "location", "provider", "string", "nominatim")
	insertPipelineConsumerSetting(t, store.SQL(), "location", "nominatim.baseUrl", "string", server.URL)
	insertPipelineConsumerTask(t, store.SQL(), 12)
	_, err = store.SQL().ExecContext(ctx, `
		UPDATE photos
		SET latitude = NULL,
		    longitude = NULL,
		    exif = '{"GPSLatitude":"45.8788","GPSLatitudeRef":"S","GPSLongitude":"170.5028","GPSLongitudeRef":"E"}'
		WHERE id = 'photo-1'
	`)
	if err != nil {
		t.Fatal(err)
	}

	application := NewApplication(Dependencies{
		Config:   config.Config{Environment: "development"},
		Logger:   slog.New(slog.NewTextHandler(os.Stderr, nil)),
		Database: store,
		Settings: settings.NewService(settings.NewSQLiteRepository(store.SQL())),
		Queue:    queue.NewSQLiteRepository(store.SQL()),
		Storage:  storage.NewSQLiteRepository(store.SQL()),
	})

	task := queue.Task{
		ID:         12,
		ClaimToken: stringPtrForTest(pipelineConsumerTestClaimToken),
		Payload:    map[string]any{"type": "photo-reverse-geocoding", "photoId": "photo-1"},
	}
	if err := application.processPhotoReverseGeocodingQueueTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	if seenLatitude != "-45.8788" || seenLongitude != "170.5028" {
		t.Fatalf("EXIF fallback request coordinates = %q,%q", seenLatitude, seenLongitude)
	}
	var country string
	if err := store.SQL().QueryRowContext(ctx, "SELECT country FROM photos WHERE id = 'photo-1'").Scan(&country); err != nil {
		t.Fatal(err)
	}
	if country != "NZ" {
		t.Fatalf("country = %q, want NZ", country)
	}
}

func TestProcessPhotoReverseGeocodingQueueTaskClearsLocationWhenCoordinatesMissing(t *testing.T) {
	ctx := context.Background()
	tempDir := t.TempDir()
	store, err := platformdb.Open(ctx, filepath.Join(tempDir, "app.sqlite3"), platformdb.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	createPipelineConsumerAppSchema(t, store.SQL(), tempDir)

	insertPipelineConsumerTask(t, store.SQL(), 13)
	_, err = store.SQL().ExecContext(ctx, `
		UPDATE photos
		SET latitude = NULL,
		    longitude = NULL,
		    exif = '{}',
		    country = 'old-country',
		    city = 'old-city',
		    location_name = 'old-location'
		WHERE id = 'photo-1'
	`)
	if err != nil {
		t.Fatal(err)
	}

	application := NewApplication(Dependencies{
		Config:   config.Config{Environment: "development"},
		Logger:   slog.New(slog.NewTextHandler(os.Stderr, nil)),
		Database: store,
		Settings: settings.NewService(settings.NewSQLiteRepository(store.SQL())),
		Queue:    queue.NewSQLiteRepository(store.SQL()),
		Storage:  storage.NewSQLiteRepository(store.SQL()),
	})

	task := queue.Task{
		ID:         13,
		ClaimToken: stringPtrForTest(pipelineConsumerTestClaimToken),
		Payload:    map[string]any{"type": "photo-reverse-geocoding", "photoId": "photo-1"},
	}
	err = application.processPhotoReverseGeocodingQueueTask(ctx, task)
	if err == nil || !strings.Contains(err.Error(), "Missing coordinates for photo photo-1") {
		t.Fatalf("error = %v, want missing coordinates", err)
	}

	var country, city, locationName sql.NullString
	if err := store.SQL().QueryRowContext(ctx, `
		SELECT country, city, location_name
		FROM photos
		WHERE id = 'photo-1'
	`).Scan(&country, &city, &locationName); err != nil {
		t.Fatal(err)
	}
	if country.Valid || city.Valid || locationName.Valid {
		t.Fatalf("location fields were not cleared: %v %v %v", country, city, locationName)
	}
}

type retryRuntimeLeaseStore struct {
	mu           sync.Mutex
	acquireAfter int
	attempts     int
	released     bool
}

func (store *retryRuntimeLeaseStore) Ping(context.Context) error {
	return nil
}

func (store *retryRuntimeLeaseStore) GetString(context.Context, string) (string, error) {
	return "", nil
}

func (store *retryRuntimeLeaseStore) TryAcquireRuntimeLease(context.Context, string, string, time.Duration) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.attempts += 1
	return store.attempts >= store.acquireAfter, nil
}

func (store *retryRuntimeLeaseStore) RefreshRuntimeLease(context.Context, string, string, time.Duration) (bool, error) {
	return true, nil
}

func (store *retryRuntimeLeaseStore) ReleaseRuntimeLease(context.Context, string, string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.released = true
	return nil
}

func (store *retryRuntimeLeaseStore) Attempts() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.attempts
}

func (store *retryRuntimeLeaseStore) Released() bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.released
}

func createPipelineConsumerAppSchema(t *testing.T, database *sql.DB, tempDir string) {
	t.Helper()
	storageRoot := filepath.Join(tempDir, "storage")
	statements := []string{
		`CREATE TABLE settings (
			id INTEGER PRIMARY KEY,
			namespace TEXT NOT NULL,
			key TEXT NOT NULL,
			type TEXT NOT NULL,
			value TEXT,
			default_value TEXT,
			label TEXT,
			description TEXT,
			is_public INTEGER NOT NULL DEFAULT 0,
			is_readonly INTEGER NOT NULL DEFAULT 0,
			is_secret INTEGER NOT NULL DEFAULT 0,
			enum TEXT,
			updated_at INTEGER NOT NULL DEFAULT 0,
			updated_by INTEGER,
			UNIQUE(namespace, key)
		);`,
		`CREATE TABLE settings_storage_providers (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT NOT NULL,
			config TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);`,
		`CREATE TABLE photos (
			id TEXT PRIMARY KEY,
			storage_key TEXT,
			exif TEXT,
			latitude REAL,
			longitude REAL,
			country TEXT,
			city TEXT,
			location_name TEXT,
			file_size INTEGER,
			last_modified TEXT,
			is_live_photo INTEGER NOT NULL DEFAULT 0,
			live_photo_video_url TEXT,
			live_photo_video_key TEXT
		);`,
		`CREATE TABLE pipeline_queue (
			id INTEGER PRIMARY KEY,
			payload TEXT NOT NULL,
			priority INTEGER NOT NULL DEFAULT 0,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 3,
			status TEXT NOT NULL DEFAULT 'pending',
				status_stage TEXT,
				error_message TEXT,
				created_at INTEGER NOT NULL DEFAULT 0,
				available_at INTEGER NOT NULL DEFAULT 0,
				claimed_by TEXT,
				claim_token TEXT,
				claim_expires_at INTEGER,
				completed_at INTEGER,
				owner_user_id INTEGER NOT NULL DEFAULT 1
			);`,
		`INSERT INTO settings(namespace, key, type, value, is_public, is_readonly, is_secret, updated_at)
		 VALUES('storage', 'provider', 'number', '1', 0, 0, 0, 1);`,
		`INSERT INTO settings_storage_providers(id, name, provider, config, created_at, updated_at)
		 VALUES(1, 'local', 'local', ` + sqlQuote(`{"basePath":`+jsonQuote(storageRoot)+`,"baseUrl":"/storage"}`) + `, 1, 1);`,
		`INSERT INTO photos(id, storage_key, is_live_photo)
		 VALUES('photo-1', 'uploads/IMG_0001.JPG', 0);`,
	}
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("exec fixture: %v", err)
		}
	}
}

func insertPipelineConsumerSetting(t *testing.T, database *sql.DB, namespace string, key string, valueType string, value string) {
	t.Helper()
	_, err := database.Exec(`
		INSERT OR REPLACE INTO settings(namespace, key, type, value, is_public, is_readonly, is_secret, updated_at)
		VALUES(?, ?, ?, ?, 0, 0, 0, 1)
	`, namespace, key, valueType, value)
	if err != nil {
		t.Fatalf("insert setting %s:%s: %v", namespace, key, err)
	}
}

func insertPipelineConsumerTask(t *testing.T, database *sql.DB, id int64) {
	t.Helper()
	_, err := database.Exec(`
		INSERT INTO pipeline_queue(id, payload, priority, attempts, max_attempts, status, created_at, available_at, claimed_by, claim_token, claim_expires_at, owner_user_id)
		VALUES(?, '{}', 0, 0, 3, 'in-stages', 1, 1, 'go-worker-test', ?, 600, 1)
	`, id, pipelineConsumerTestClaimToken)
	if err != nil {
		t.Fatalf("insert pipeline task %d: %v", id, err)
	}
}

func stringPtrForTest(value string) *string {
	return &value
}

func sqlQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func jsonQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
