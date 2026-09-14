package app

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
)

func TestDisplayRouteRejectsHiddenPhotoForNonOwnerBeforeProvider(t *testing.T) {
	handler, store := newWizardTestApplication(t)
	insertDisplayAccessTestPhotos(t, store.SQL())

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/display/hidden-display-photo", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "Photo not found") {
		t.Fatalf("body = %s, want Photo not found", response.Body.String())
	}
	if strings.Contains(response.Body.String(), "Storage provider unavailable") {
		t.Fatalf("display route reached storage provider before rejecting hidden photo: %s", response.Body.String())
	}
	if got := response.Header().Get("Vary"); got != "Cookie" {
		t.Fatalf("Vary = %q, want Cookie", got)
	}
}

func TestDisplayPhotoAccessMatchesNodeOwnerAdminAndPublicRules(t *testing.T) {
	_, store := newWizardTestApplication(t)
	insertDisplayAccessTestPhotos(t, store.SQL())
	application := NewApplication(Dependencies{Database: store})
	ctx := context.Background()

	public, err := application.isPublicMediaPhoto(ctx, "public-display-photo")
	if err != nil {
		t.Fatal(err)
	}
	if !public {
		t.Fatal("public-display-photo should be public")
	}

	hidden, err := application.isPublicMediaPhoto(ctx, "hidden-display-photo")
	if err != nil {
		t.Fatal(err)
	}
	if hidden {
		t.Fatal("hidden-display-photo should not be public")
	}

	photo := mediaPhoto{ID: "hidden-display-photo", OwnerUserID: 101}
	if !canManageMediaPhoto(&auth.User{ID: 101}, photo) {
		t.Fatal("photo owner should manage display media")
	}
	if !canManageMediaPhoto(&auth.User{ID: 202, IsAdmin: 1}, photo) {
		t.Fatal("admin should manage display media")
	}
	if canManageMediaPhoto(&auth.User{ID: 202}, photo) {
		t.Fatal("unrelated non-admin user should not manage display media")
	}
	if canManageMediaPhoto(nil, photo) {
		t.Fatal("anonymous user should not manage display media")
	}
}

func TestDisplayRouteRequiresGeneratedImagePersistence(t *testing.T) {
	source, err := os.ReadFile("media_handlers.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if strings.Contains(text, "if stored, err := provider.Put") {
		t.Fatal("display route must not swallow generated display image storage write errors")
	}
	for _, want := range []string{
		"Go display image storage write failed",
		"Go display image key update failed",
		"UPDATE photos SET display_key = ? WHERE id = ?",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("media_handlers.go is missing %q", want)
		}
	}
}

func TestStorageRouteUsesTheActiveProviderForLocalAndRemoteObjects(t *testing.T) {
	source, err := os.ReadFile("media_handlers.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if strings.Contains(text, `provider.Kind() != "local"`) {
		t.Fatal("storage route must not reject S3 or OpenList providers")
	}
	for _, want := range []string{
		"func (a *Application) storageRoute",
		"a.serveMediaWithProvider(w, r, provider, key, true)",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("media_handlers.go is missing %q", want)
		}
	}
}

func TestShareOGTextAndTemplatesMatchNodeSemantics(t *testing.T) {
	whitespace := "   "
	location := "fallback city"
	description := "  keep  inner spacing  "
	photo := shareOGPhoto{
		Title:        &whitespace,
		Description:  &description,
		City:         &whitespace,
		LocationName: &location,
		Exif: map[string]any{
			"Make":                    "ChronoFrame",
			"Model":                   "ParityCam",
			"FocalLengthIn35mmFormat": 35.0,
			"FNumber":                 2.8,
			"ExposureTime":            "1/125",
			"ISO":                     200.0,
		},
	}

	if got := truncateText(nodeStringOr(photo.Title, "fallback"), 16); got != "" {
		t.Fatalf("whitespace title = %q, want the Node truthy-before-trim result", got)
	}
	if got := truncateText("12345678901234😀x", 16); got != "12345678901234�…" {
		t.Fatalf("UTF-16 truncation = %q", got)
	}

	overlay := shareOverlaySVG(photo, "PHOTO", "Title", "ChronoFrame")
	for _, want := range []string{
		`<filter id="softShadow"`,
		`<g filter="url(#softShadow)">`,
		`keep  inner spacing`,
		`ChronoFrame ParityCam`,
		`35`,
		`f/2.8`,
		`1/125s`,
		`200`,
	} {
		if !strings.Contains(overlay, want) {
			t.Fatalf("share overlay is missing %q", want)
		}
	}
	if strings.Contains(overlay, location) {
		t.Fatal("Node does not fall back from a truthy whitespace city before truncation")
	}

	fallback := fallbackShareSVG("PHOTO", "Title", "ChronoFrame")
	for _, want := range []string{`id="photoFade"`, `id="softShadow"`, `>—</text>`} {
		if !strings.Contains(fallback, want) {
			t.Fatalf("share fallback is missing %q", want)
		}
	}
	media := fallbackMediaSVG("PHOTO", "Title")
	if got := strings.Count(media, `width="24"`); got != 16 {
		t.Fatalf("fallback stripe count = %d, want 16", got)
	}
}

func TestShareOGMachineDescriptionAndExifTruthinessMatchNode(t *testing.T) {
	machine := `{"ARInfo":{"scene":"portrait"}}`
	overlay := shareOverlaySVG(
		shareOGPhoto{
			Description: &machine,
			Exif: map[string]any{
				"FocalLengthIn35mmFormat": 0.0,
				"FNumber":                 false,
				"ExposureTime":            "",
				"ISO":                     0.0,
			},
		},
		"PHOTO",
		"Title",
		"ChronoFrame",
	)
	if strings.Contains(overlay, "ARInfo") {
		t.Fatal("machine-generated description must not be rendered")
	}
	if got := strings.Count(overlay, `>—</text>`); got != 4 {
		t.Fatalf("empty/falsy EXIF placeholder count = %d, want 4", got)
	}
}

func insertDisplayAccessTestPhotos(t *testing.T, database *sql.DB) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO users(id, name, email, password, created_at, is_admin, is_active, auth_version)
		VALUES
			(101, 'display-owner', 'display-owner@example.test', '$2a$10$placeholder', 1, 0, 1, 1),
			(202, 'display-other', 'display-other@example.test', '$2a$10$placeholder', 1, 0, 1, 1);

		INSERT INTO photos(id, media_type, storage_key, owner_user_id)
		VALUES
			('public-display-photo', 'image', 'users/101/public.jpg', 101),
			('hidden-display-photo', 'image', 'users/101/hidden.jpg', 101);

		INSERT INTO albums(id, title, description, cover_photo_id, is_hidden, created_at, updated_at, owner_user_id)
		VALUES(91001, 'Hidden Display Album', NULL, 'hidden-display-photo', 1, 1, 1, 101);

		INSERT INTO album_photos(album_id, photo_id, position, added_at)
		VALUES(91001, 'hidden-display-photo', 1, 1);
	`); err != nil {
		t.Fatal(err)
	}
}
