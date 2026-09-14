package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
)

func TestPhotoAlbumsBodyValidationMatchesNodeSchema(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "single rejects null albumIds", body: `{"albumIds":null}`},
		{name: "single rejects non-positive albumIds", body: `{"albumIds":[1,0]}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodePhotoAlbumsUpdateBody(
				response,
				httptest.NewRequest(http.MethodPut, "/api/photos/p/albums", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodePhotoAlbumsUpdateBody() ok = true, want false")
			}
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}

	invalidResponse := httptest.NewRecorder()
	_, ok := decodePhotoAlbumsUpdateBody(
		invalidResponse,
		httptest.NewRequest(http.MethodPut, "/api/photos/p/albums", strings.NewReader(`{"albumIds":[0]}`)),
	)
	if ok {
		t.Fatal("decodePhotoAlbumsUpdateBody() ok = true, want false")
	}
	want := `{"error":true,"statusCode":400,"statusMessage":"Validation Error","message":"[\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"inclusive\": false,\n    \"path\": [\n      \"albumIds\",\n      0\n    ],\n    \"message\": \"Too small: expected number to be \u003e0\"\n  }\n]","data":{"name":"ZodError","message":"[\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"inclusive\": false,\n    \"path\": [\n      \"albumIds\",\n      0\n    ],\n    \"message\": \"Too small: expected number to be \u003e0\"\n  }\n]"}}` + "\n"
	if got := invalidResponse.Body.String(); got != want {
		t.Fatalf("error body = %s, want %s", got, want)
	}

	for _, test := range []struct {
		name string
		body string
	}{
		{name: "bulk rejects missing photoIds", body: `{}`},
		{name: "bulk rejects empty photo id", body: `{"photoIds":[""]}`},
		{name: "bulk rejects null albumIds", body: `{"photoIds":["p"],"albumIds":null}`},
		{name: "bulk rejects non-positive albumIds", body: `{"photoIds":["p"],"albumIds":[-1]}`},
		{name: "bulk rejects null mode", body: `{"photoIds":["p"],"mode":null}`},
		{name: "bulk rejects unknown mode", body: `{"photoIds":["p"],"mode":"merge"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodePhotoAlbumsBulkUpdateBody(
				response,
				httptest.NewRequest(http.MethodPut, "/api/photos/albums", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodePhotoAlbumsBulkUpdateBody() ok = true, want false")
			}
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}

	response := httptest.NewRecorder()
	body, ok := decodePhotoAlbumsBulkUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPut,
			"/api/photos/albums",
			strings.NewReader(`{"photoIds":["p1","p1"],"albumIds":[2,2],"mode":"add"}`),
		),
	)
	if !ok {
		t.Fatalf("valid bulk body rejected: %s", response.Body.String())
	}
	if !reflect.DeepEqual(body.PhotoIDs, []string{"p1"}) ||
		!reflect.DeepEqual(body.AlbumIDs, []int64{2}) ||
		body.Mode != "add" {
		t.Fatalf("decoded body = %#v", body)
	}
}

func TestReplacePhotoAlbumsScopesManagedRelationsAndClearsCoverLikeNode(t *testing.T) {
	ctx := context.Background()
	_, store := newWizardTestApplication(t)
	seedPhotoAlbumRelationFixture(t, store.SQL())
	application := &Application{database: store}
	member := &auth.User{ID: 1, IsAdmin: 0}

	if !application.replacePhotoAlbums(ctx, "photo-1", []int64{11}, member) {
		t.Fatal("replacePhotoAlbums() = false, want true")
	}

	if got, want := albumIDsForPhoto(t, store.SQL(), "photo-1"), []int64{20, 11}; !reflect.DeepEqual(got, want) {
		t.Fatalf("album IDs for photo-1 = %#v, want %#v", got, want)
	}
	if got := albumCoverPhotoID(t, store.SQL(), 10); got.Valid {
		t.Fatalf("member album cover = %#v, want NULL", got.String)
	}
	if got := albumCoverPhotoID(t, store.SQL(), 20); !got.Valid || got.String != "photo-1" {
		t.Fatalf("other album cover = %#v, want photo-1", got)
	}
}

func TestPhotoAlbumsBulkUpdateUsesNodeAllOrNothingSemantics(t *testing.T) {
	ctx := context.Background()
	_, store := newWizardTestApplication(t)
	seedPhotoAlbumRelationFixture(t, store.SQL())
	application := &Application{database: store}
	member := &auth.User{ID: 1, IsAdmin: 0}

	if err := application.applyPhotoAlbumsBulkUpdate(
		ctx,
		[]string{"photo-1", "photo-2"},
		[]int64{11},
		"replace",
		member,
	); err != nil {
		t.Fatalf("applyPhotoAlbumsBulkUpdate() error = %v", err)
	}

	if got, want := albumIDsForPhoto(t, store.SQL(), "photo-1"), []int64{20, 11}; !reflect.DeepEqual(got, want) {
		t.Fatalf("album IDs for photo-1 = %#v, want %#v", got, want)
	}
	if got, want := albumIDsForPhoto(t, store.SQL(), "photo-2"), []int64{11}; !reflect.DeepEqual(got, want) {
		t.Fatalf("album IDs for photo-2 = %#v, want %#v", got, want)
	}
	if got := albumCoverPhotoID(t, store.SQL(), 10); got.Valid {
		t.Fatalf("member album cover = %#v, want NULL", got.String)
	}
	if got := albumCoverPhotoID(t, store.SQL(), 20); !got.Valid || got.String != "photo-1" {
		t.Fatalf("other album cover = %#v, want photo-1", got)
	}
	if got, want := albumPositions(t, store.SQL(), 11), []float64{1000010, 1000020}; !reflect.DeepEqual(got, want) {
		t.Fatalf("album 11 positions = %#v, want %#v", got, want)
	}
}

func TestWritePhotoAlbumResponseMatchesNodeMutationSummary(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedPhotoAlbumRelationFixture(t, store.SQL())
	application := &Application{database: store}

	response := httptest.NewRecorder()
	application.writePhotoAlbumResponse(
		response,
		httptest.NewRequest(http.MethodPut, "/api/photos/photo-1/albums", nil),
		"photo-1",
		http.StatusOK,
	)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		PhotoID  string           `json:"photoId"`
		Albums   []map[string]any `json:"albums"`
		AlbumIDs []int64          `json:"albumIds"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.PhotoID != "photo-1" {
		t.Fatalf("photoId = %q, want photo-1", payload.PhotoID)
	}
	if got, want := payload.AlbumIDs, []int64{10, 20}; !reflect.DeepEqual(got, want) {
		t.Fatalf("albumIds = %#v, want %#v", got, want)
	}
	if len(payload.Albums) != 2 {
		t.Fatalf("albums length = %d, want 2", len(payload.Albums))
	}
	for _, album := range payload.Albums {
		if _, exists := album["description"]; exists {
			t.Fatalf("mutation album summary leaked GET-only field: %#v", album)
		}
		if _, exists := album["ownerUserId"]; !exists {
			t.Fatalf("mutation album summary missing ownerUserId: %#v", album)
		}
		if _, exists := album["isHidden"]; !exists {
			t.Fatalf("mutation album summary missing isHidden: %#v", album)
		}
	}
}

func seedPhotoAlbumRelationFixture(t *testing.T, database *sql.DB) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO users(id,name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES
			(1, 'member', 'member@example.test', '$2a$10$placeholder', unixepoch(), 0, 1, 1),
			(2, 'other', 'other@example.test', '$2a$10$placeholder', unixepoch(), 0, 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
		INSERT INTO photos(id,title,owner_user_id)
		VALUES
			('photo-1', 'Photo 1', 1),
			('photo-2', 'Photo 2', 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
		INSERT INTO albums(id,title,cover_photo_id,is_hidden,owner_user_id)
		VALUES
			(10, 'Member Album', 'photo-1', 0, 1),
			(11, 'Target Album', NULL, 0, 1),
			(20, 'Other Album', 'photo-1', 1, 2)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
		INSERT INTO album_photos(album_id,photo_id,position)
		VALUES
			(10, 'photo-1', 100),
			(20, 'photo-1', 200),
			(10, 'photo-2', 300)
	`); err != nil {
		t.Fatal(err)
	}
}

func albumIDsForPhoto(t *testing.T, database *sql.DB, photoID string) []int64 {
	t.Helper()
	rows, err := database.Query(`
		SELECT album_id
		FROM album_photos
		WHERE photo_id = ?
		ORDER BY position ASC, album_id ASC
	`, photoID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids
}

func albumCoverPhotoID(t *testing.T, database *sql.DB, albumID int64) sql.NullString {
	t.Helper()
	var value sql.NullString
	if err := database.QueryRow("SELECT cover_photo_id FROM albums WHERE id = ?", albumID).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func albumPositions(t *testing.T, database *sql.DB, albumID int64) []float64 {
	t.Helper()
	rows, err := database.Query(`
		SELECT position
		FROM album_photos
		WHERE album_id = ?
		ORDER BY position ASC
	`, albumID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	positions := []float64{}
	for rows.Next() {
		var position float64
		if err := rows.Scan(&position); err != nil {
			t.Fatal(err)
		}
		positions = append(positions, position)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return positions
}
