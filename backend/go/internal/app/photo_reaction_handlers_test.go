package app

import (
	"database/sql"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/photos"
)

func TestPhotoReactionCountsRequiresIDsLikeNode(t *testing.T) {
	_, store := newWizardTestApplication(t)
	application := &Application{
		photos: photos.NewSQLiteRepository(store.SQL()),
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	request := httptest.NewRequest(http.MethodGet, "/api/photos/reactions", nil)
	response := httptest.NewRecorder()

	application.photoReactionCounts(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, `"statusMessage":"Server Error"`) ||
		!strings.Contains(body, `"message":"Photo IDs are required"`) {
		t.Fatalf("body = %s, want Node-compatible missing ids error", body)
	}
}

func TestPhotoReactionCountsRejectsSingleEmptyIDLikeNode(t *testing.T) {
	_, store := newWizardTestApplication(t)
	application := &Application{
		photos: photos.NewSQLiteRepository(store.SQL()),
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	request := httptest.NewRequest(http.MethodGet, "/api/photos/reactions?ids=", nil)
	response := httptest.NewRecorder()

	application.photoReactionCounts(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"message":"Photo IDs are required"`) {
		t.Fatalf("body = %s, want Node-compatible missing ids error", response.Body.String())
	}
}

func TestPhotoReactionCountsPreservesRepeatedEmptyIDsLikeNode(t *testing.T) {
	_, store := newWizardTestApplication(t)
	application := &Application{
		photos: photos.NewSQLiteRepository(store.SQL()),
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	request := httptest.NewRequest(http.MethodGet, "/api/photos/reactions?ids=&ids=", nil)
	response := httptest.NewRecorder()

	application.photoReactionCounts(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	for _, reactionType := range photos.ReactionTypes {
		if !strings.Contains(response.Body.String(), `"`+reactionType+`":0`) {
			t.Fatalf("body = %s, want zero %s bucket", response.Body.String(), reactionType)
		}
	}
}

func TestPhotoReactionPostRateLimitMatchesNodeWindow(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedReactionUser(t, store.SQL())
	seedReactionPhoto(t, store.SQL(), "target-photo")

	request := newReactionMutationRequest(
		http.MethodPost,
		"target-photo",
		`{"reactionType":"fire"}`,
	)
	fingerprint := requestFingerprint(request)
	for index := 0; index < photoReactionRateLimitMax; index++ {
		photoID := "recent-photo-" + strconv.Itoa(index)
		seedReactionPhoto(t, store.SQL(), photoID)
		seedReaction(t, store.SQL(), photoID, fingerprint, "like", 970)
	}

	application := &Application{
		database: store,
		now:      func() time.Time { return time.Unix(1000, 0).UTC() },
	}
	response := httptest.NewRecorder()
	application.photoReactionMutation(response, request)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"statusMessage":"Server Error"`) ||
		!strings.Contains(response.Body.String(), `"message":"Too many reactions. Please try again later."`) {
		t.Fatalf("body = %s, want Node-compatible rate limit error", response.Body.String())
	}
	if got := reactionCount(t, store.SQL(), "target-photo", fingerprint); got != 0 {
		t.Fatalf("target reaction count = %d, want 0", got)
	}
}

func TestPhotoReactionRateLimitIgnoresOlderRowsLikeNode(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedReactionUser(t, store.SQL())
	seedReactionPhoto(t, store.SQL(), "target-photo")

	request := newReactionMutationRequest(
		http.MethodPost,
		"target-photo",
		`{"reactionType":"sparkle"}`,
	)
	fingerprint := requestFingerprint(request)
	for index := 0; index < photoReactionRateLimitMax; index++ {
		photoID := "old-photo-" + strconv.Itoa(index)
		seedReactionPhoto(t, store.SQL(), photoID)
		seedReaction(t, store.SQL(), photoID, fingerprint, "like", 939)
	}

	application := &Application{
		database: store,
		now:      func() time.Time { return time.Unix(1000, 0).UTC() },
	}
	response := httptest.NewRecorder()
	application.photoReactionMutation(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"action":"created"`) ||
		!strings.Contains(response.Body.String(), `"reactionType":"sparkle"`) {
		t.Fatalf("body = %s, want created sparkle reaction", response.Body.String())
	}
}

func TestPhotoReactionUpdateIsRateLimitedBeforeMutationLikeNode(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedReactionUser(t, store.SQL())
	seedReactionPhoto(t, store.SQL(), "target-photo")

	request := newReactionMutationRequest(
		http.MethodPost,
		"target-photo",
		`{"reactionType":"love"}`,
	)
	fingerprint := requestFingerprint(request)
	seedReaction(t, store.SQL(), "target-photo", fingerprint, "like", 970)
	for index := 0; index < photoReactionRateLimitMax-1; index++ {
		photoID := "other-recent-photo-" + strconv.Itoa(index)
		seedReactionPhoto(t, store.SQL(), photoID)
		seedReaction(t, store.SQL(), photoID, fingerprint, "fire", 970)
	}

	application := &Application{
		database: store,
		now:      func() time.Time { return time.Unix(1000, 0).UTC() },
	}
	response := httptest.NewRecorder()
	application.photoReactionMutation(response, request)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got := reactionType(t, store.SQL(), "target-photo", fingerprint); got != "like" {
		t.Fatalf("target reaction type = %q, want unchanged like", got)
	}
}

func TestPhotoReactionPostChecksPhotoExistenceLikeNode(t *testing.T) {
	_, store := newWizardTestApplication(t)
	application := &Application{
		database: store,
		now:      func() time.Time { return time.Unix(1000, 0).UTC() },
	}
	response := httptest.NewRecorder()
	application.photoReactionMutation(
		response,
		newReactionMutationRequest(
			http.MethodPost,
			"missing-photo",
			`{"reactionType":"like"}`,
		),
	)

	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"statusMessage":"Server Error"`) ||
		!strings.Contains(response.Body.String(), `"message":"Photo not found"`) {
		t.Fatalf("body = %s, want Node-compatible Photo not found error", response.Body.String())
	}
}

func TestPhotoReactionPostPreservesWhitespacePhotoIDLikeNode(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedReactionUser(t, store.SQL())
	seedReactionPhoto(t, store.SQL(), " whitespace-photo ")
	application := &Application{
		database: store,
		now:      func() time.Time { return time.Unix(1000, 0).UTC() },
	}
	response := httptest.NewRecorder()
	request := newReactionMutationRequest(
		http.MethodPost,
		"%20whitespace-photo%20",
		`{"reactionType":"like"}`,
	)
	request.SetPathValue("photoID", " whitespace-photo ")

	application.photoReactionMutation(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"action":"created"`) {
		t.Fatalf("body = %s, want reaction for the untrimmed photo id", response.Body.String())
	}
}

func TestPhotoReactionPostInvalidTypeMatchesNodeErrorEnvelope(t *testing.T) {
	_, store := newWizardTestApplication(t)
	seedReactionUser(t, store.SQL())
	seedReactionPhoto(t, store.SQL(), "target-photo")
	application := &Application{database: store}
	response := httptest.NewRecorder()

	application.photoReactionMutation(
		response,
		newReactionMutationRequest(http.MethodPost, "target-photo", `{}`),
	)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"statusMessage":"Server Error"`) ||
		!strings.Contains(response.Body.String(), `"message":"Invalid reaction type"`) {
		t.Fatalf("body = %s, want Node-compatible invalid reaction error", response.Body.String())
	}
}

func TestRequestFingerprintPrefersOriginalAcceptEncodingFromNodeGateway(t *testing.T) {
	request := newReactionMutationRequest(
		http.MethodGet,
		"target-photo",
		"",
	)
	request.Header.Set("Accept-Encoding", "gzip, deflate")
	request.Header.Set("X-ChronoFrame-Original-Accept-Encoding", "gzip")

	want := base64.StdEncoding.EncodeToString([]byte(
		"198.51.100.9|chronoframe-go-reaction-test|en-US|gzip",
	))
	if got := requestFingerprint(request); got != want {
		t.Fatalf("requestFingerprint() = %q, want %q", got, want)
	}
}

func TestRequestFingerprintUsesAcceptEncodingWhenDirectToGo(t *testing.T) {
	request := newReactionMutationRequest(
		http.MethodGet,
		"target-photo",
		"",
	)
	request.Header.Set("Accept-Encoding", "gzip, deflate")

	want := base64.StdEncoding.EncodeToString([]byte(
		"198.51.100.9|chronoframe-go-reaction-test|en-US|gzip, deflate",
	))
	if got := requestFingerprint(request); got != want {
		t.Fatalf("requestFingerprint() = %q, want %q", got, want)
	}
}

func newReactionMutationRequest(method string, photoID string, body string) *http.Request {
	request := httptest.NewRequest(method, "/api/photos/"+photoID+"/reactions", strings.NewReader(body))
	request.SetPathValue("photoID", photoID)
	request.RemoteAddr = "198.51.100.9:43210"
	request.Header.Set("X-Forwarded-For", "198.51.100.9")
	request.Header.Set("User-Agent", "chronoframe-go-reaction-test")
	request.Header.Set("Accept-Language", "en-US")
	request.Header.Set("Accept-Encoding", "gzip")
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	return request
}

func seedReactionUser(t *testing.T, database *sql.DB) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO users(id,name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES(1, 'reaction-owner', 'reaction-owner@example.test', '$2a$10$placeholder', 900, 0, 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
}

func seedReactionPhoto(t *testing.T, database *sql.DB, photoID string) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO photos(id,title,owner_user_id,last_modified)
		VALUES(?, ?, 1, '2026-09-12T00:00:00.000Z')
	`, photoID, photoID); err != nil {
		t.Fatal(err)
	}
}

func seedReaction(
	t *testing.T,
	database *sql.DB,
	photoID string,
	fingerprint string,
	reactionType string,
	createdAt int64,
) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO photo_reactions(photo_id,reaction_type,fingerprint,ip_address,user_agent,created_at,updated_at)
		VALUES(?, ?, ?, '198.51.100.9', 'chronoframe-go-reaction-test', ?, ?)
	`, photoID, reactionType, fingerprint, createdAt, createdAt); err != nil {
		t.Fatal(err)
	}
}

func reactionCount(t *testing.T, database *sql.DB, photoID string, fingerprint string) int64 {
	t.Helper()
	var count int64
	if err := database.QueryRow(`
		SELECT COUNT(*)
		FROM photo_reactions
		WHERE photo_id = ? AND fingerprint = ?
	`, photoID, fingerprint).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func reactionType(t *testing.T, database *sql.DB, photoID string, fingerprint string) string {
	t.Helper()
	var value string
	if err := database.QueryRow(`
		SELECT reaction_type
		FROM photo_reactions
		WHERE photo_id = ? AND fingerprint = ?
	`, photoID, fingerprint).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
