package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/albums"
)

func TestDecodeAlbumCreateBodyMatchesNodeZodSchema(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeAlbumCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/albums",
			strings.NewReader(`{"title":null,"description":null,"coverPhotoId":null,"photoIds":null,"isHidden":null}`),
		),
	)
	if ok {
		t.Fatal("decodeAlbumCreateBody() ok = true, want false")
	}
	wantMessage := zodValidationMessage(
		zodInvalidTypeIssue([]any{"title"}, "string", "null"),
		zodInvalidTypeIssue([]any{"description"}, "string", "null"),
		zodInvalidTypeIssue([]any{"coverPhotoId"}, "string", "null"),
		zodInvalidTypeIssue([]any{"photoIds"}, "array", "null"),
		zodInvalidTypeIssue([]any{"isHidden"}, "boolean", "null"),
	)
	expectAlbumValidationError(t, response, wantMessage)

	response = httptest.NewRecorder()
	body, ok := decodeAlbumCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/albums",
			strings.NewReader(`{"title":"   ","description":"  kept  ","coverPhotoId":" cover ","photoIds":["", " p "],"isHidden":true}`),
		),
	)
	if !ok {
		t.Fatalf("valid album create body rejected: %s", response.Body.String())
	}
	if body.Title != "   " || body.Description == nil || *body.Description != "  kept  " ||
		body.CoverPhoto == nil || *body.CoverPhoto != " cover " || !body.IsHidden ||
		!reflect.DeepEqual(body.PhotoIDs, []string{"", " p "}) {
		t.Fatalf("decoded album create body = %#v, want exact Node string semantics", body)
	}
}

func TestDecodeAlbumUpdateBodyRejectsNullOptionalFieldsLikeNode(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeAlbumUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPut,
			"/api/albums/42",
			strings.NewReader(`{"title":null,"description":null,"coverPhotoId":null,"photoIds":null,"isHidden":null}`),
		),
	)
	if ok {
		t.Fatal("decodeAlbumUpdateBody() ok = true, want false")
	}
	wantMessage := zodValidationMessage(
		zodInvalidTypeIssue([]any{"title"}, "string", "null"),
		zodInvalidTypeIssue([]any{"description"}, "string", "null"),
		zodInvalidTypeIssue([]any{"coverPhotoId"}, "string", "null"),
		zodInvalidTypeIssue([]any{"photoIds"}, "array", "null"),
		zodInvalidTypeIssue([]any{"isHidden"}, "boolean", "null"),
	)
	expectAlbumValidationError(t, response, wantMessage)
}

func TestUniqueAlbumPhotoIDsMatchesNodeSetSemantics(t *testing.T) {
	cover := " cover-photo "
	got := uniqueAlbumPhotoIDs(
		[]string{"photo-a", "", "photo-a", " photo-b ", " cover-photo "},
		&cover,
	)
	want := []string{"photo-a", "", " photo-b ", " cover-photo "}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("uniqueAlbumPhotoIDs() = %#v, want %#v", got, want)
	}
}

func TestAlbumCreateTransactionPreservesTextAndAddsCoverRelation(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedAlbumMutationFixture(t, store.SQL())
	application := &Application{
		database: store,
		now:      func() time.Time { return time.Unix(1_000, 0).UTC() },
	}
	description := "  preserved description  "
	cover := "cover-photo"
	body := albumCreateBody{
		Title:       "   ",
		Description: &description,
		CoverPhoto:  &cover,
		PhotoIDs:    []string{"photo-a", "photo-a"},
		IsHidden:    true,
	}
	relationPhotoIDs := uniqueAlbumPhotoIDs(body.PhotoIDs, body.CoverPhoto)

	id, err := application.createAlbumTransaction(
		context.Background(),
		body,
		1,
		relationPhotoIDs,
	)
	if err != nil {
		t.Fatalf("createAlbumTransaction() error = %v", err)
	}

	var (
		title       string
		storedDesc  string
		storedCover string
		hidden      int64
	)
	if err := store.SQL().QueryRow(`
		SELECT title, description, cover_photo_id, is_hidden
		FROM albums
		WHERE id = ?
	`, id).Scan(&title, &storedDesc, &storedCover, &hidden); err != nil {
		t.Fatal(err)
	}
	if title != body.Title || storedDesc != description || storedCover != cover || hidden != 1 {
		t.Fatalf(
			"stored album = %#v, want exact text and cover values",
			[]any{title, storedDesc, storedCover, hidden},
		)
	}
	if got, want := albumPhotoIDsForTest(t, store.SQL(), id), []string{"photo-a", "cover-photo"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("album photo ids = %#v, want %#v", got, want)
	}
}

func TestAlbumUpdateTransactionRollsBackFieldsWhenRelationWriteFails(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedAlbumMutationFixture(t, store.SQL())
	if _, err := store.SQL().Exec(`
		INSERT INTO albums(id,title,description,is_hidden,owner_user_id)
		VALUES(42, 'original title', 'original description', 0, 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SQL().Exec(`
		INSERT INTO album_photos(album_id,photo_id,position)
		VALUES(42, 'photo-a', 1000010)
	`); err != nil {
		t.Fatal(err)
	}
	application := &Application{database: store}
	replacement := []string{"missing-photo"}

	err := application.updateAlbumTransaction(
		context.Background(),
		42,
		[]string{"title = ?", "description = ?", "updated_at = unixepoch()"},
		[]any{"changed title", "changed description"},
		&replacement,
	)
	if err == nil {
		t.Fatal("updateAlbumTransaction() error = nil, want relation failure")
	}

	var title, description string
	if err := store.SQL().QueryRow(`
		SELECT title, description FROM albums WHERE id = 42
	`).Scan(&title, &description); err != nil {
		t.Fatal(err)
	}
	if title != "original title" || description != "original description" {
		t.Fatalf("album fields = %q, %q, want original values", title, description)
	}
	if got, want := albumPhotoIDsForTest(t, store.SQL(), 42), []string{"photo-a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("album photo ids = %#v, want %#v", got, want)
	}
}

func TestJSStringLengthUsesUTF16CodeUnitsLikeNode(t *testing.T) {
	if got := jsStringLength("a😀界"); got != 4 {
		t.Fatalf("jsStringLength() = %d, want 4", got)
	}
}

func TestAlbumMutationResponseMatchesRawNodeAlbumRow(t *testing.T) {
	description := "description"
	cover := "photo-a"
	response := albumMutationResponse(albums.Album{
		ID:           42,
		Title:        "album",
		Description:  &description,
		CoverPhotoID: &cover,
		IsHidden:     true,
		CreatedAt:    "2027-01-01T00:00:00.000Z",
		UpdatedAt:    "2027-01-01T00:00:01.000Z",
		OwnerUserID:  7,
		Owner:        &albums.Owner{ID: 7, Username: "owner"},
		PhotoIDs:     []string{"photo-a"},
	})

	wantKeys := []string{
		"coverPhotoId", "createdAt", "description", "id", "isHidden",
		"ownerUserId", "title", "updatedAt",
	}
	gotKeys := make([]string, 0, len(response))
	for key := range response {
		gotKeys = append(gotKeys, key)
	}
	slices.Sort(gotKeys)
	if !reflect.DeepEqual(gotKeys, wantKeys) {
		t.Fatalf("album mutation response keys = %#v, want %#v", gotKeys, wantKeys)
	}
	if _, exists := response["owner"]; exists {
		t.Fatal("album mutation response unexpectedly includes owner")
	}
	if _, exists := response["photoIds"]; exists {
		t.Fatal("album mutation response unexpectedly includes photoIds")
	}
}

func TestParseAlbumIDPathUsesNodeZodErrorShape(t *testing.T) {
	response := httptest.NewRecorder()
	if _, ok := parseAlbumIDPath(response, "not-a-number"); ok {
		t.Fatal("parseAlbumIDPath() ok = true, want false")
	}
	if response.Code != http.StatusBadRequest {
		t.Fatalf("parseAlbumIDPath() status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["statusMessage"] != "Validation Error" || body["message"] != invalidAlbumIDMessage {
		t.Fatalf("parseAlbumIDPath() body = %#v", body)
	}
}

func TestDecodePhotoAlbumsBulkUpdateBodyMatchesNodeZodErrors(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		message string
	}{
		{
			name:    "missing photoIds",
			body:    `{"albumIds":[]}`,
			message: zodValidationMessage(zodInvalidTypeIssue([]any{"photoIds"}, "array", "undefined")),
		},
		{
			name: "empty photoIds",
			body: `{"photoIds":[]}`,
			message: zodValidationMessage(zodTooSmallArrayIssue(
				[]any{"photoIds"}, 1, "Too small: expected array to have >=1 items",
			)),
		},
		{
			name:    "empty photoId item",
			body:    `{"photoIds":[""]}`,
			message: zodValidationMessage(zodTooSmallStringIssue([]any{"photoIds", 0}, 1)),
		},
		{
			name: "invalid mode",
			body: `{"photoIds":["photo-a"],"mode":"merge"}`,
			message: zodValidationMessage(zodEnumValidationIssue(zodEnumIssue{
				path: []any{"mode"}, values: []string{"replace", "add", "remove"},
			})),
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodePhotoAlbumsBulkUpdateBody(
				response,
				httptest.NewRequest(http.MethodPut, "/api/photos/albums", strings.NewReader(testCase.body)),
			)
			if ok {
				t.Fatal("decodePhotoAlbumsBulkUpdateBody() ok = true, want false")
			}
			expectAlbumValidationError(t, response, testCase.message)
		})
	}
}

func seedAlbumMutationFixture(t *testing.T, database *sql.DB) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO users(id,name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES(1, 'album-owner', 'album-owner@example.test', '$2a$10$placeholder', 900, 0, 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
		INSERT INTO photos(id,title,owner_user_id)
		VALUES
			('photo-a', 'Photo A', 1),
			('cover-photo', 'Cover Photo', 1)
	`); err != nil {
		t.Fatal(err)
	}
}

func albumPhotoIDsForTest(t *testing.T, database *sql.DB, albumID int64) []string {
	t.Helper()
	rows, err := database.Query(`
		SELECT photo_id
		FROM album_photos
		WHERE album_id = ?
		ORDER BY position ASC
	`, albumID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
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

func expectAlbumValidationError(
	t *testing.T,
	response *httptest.ResponseRecorder,
	wantMessage string,
) {
	t.Helper()
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		StatusMessage string `json:"statusMessage"`
		Message       string `json:"message"`
		Data          struct {
			Name    string `json:"name"`
			Message string `json:"message"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.StatusMessage != "Validation Error" || body.Message != wantMessage ||
		body.Data.Name != "ZodError" || body.Data.Message != wantMessage {
		t.Fatalf("validation body = %#v, want Node-compatible Zod error", body)
	}
}
