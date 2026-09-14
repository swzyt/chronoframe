package app

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeAdminUserCreateBodyMatchesNodeZodSchema(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeAdminUserCreateBody(
		response,
		httptest.NewRequest(http.MethodPost, "/api/admin/users", strings.NewReader(`{}`)),
	)
	if ok {
		t.Fatal("decodeAdminUserCreateBody() ok = true, want false")
	}
	wantMessage := zodValidationMessage(
		zodInvalidTypeIssue([]any{"username"}, "string", "undefined"),
		zodInvalidTypeIssue([]any{"email"}, "string", "undefined"),
		zodInvalidTypeIssue([]any{"password"}, "string", "undefined"),
	)
	expectAlbumValidationError(t, response, wantMessage)

	response = httptest.NewRecorder()
	body, ok := decodeAdminUserCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/admin/users",
			strings.NewReader(`{"username":"  Alice  ","email":"ALICE@Example.COM","password":"password-123"}`),
		),
	)
	if !ok {
		t.Fatalf("valid admin user body rejected: %s", response.Body.String())
	}
	if body.Username != "Alice" || body.Email != "alice@example.com" ||
		body.Password != "password-123" || body.IsAdmin {
		t.Fatalf("decoded admin user body = %#v, want Node transformations", body)
	}
}

func TestDecodeAdminUserCreateBodyValidatesBeforeEmailTrimLikeNode(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeAdminUserCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/admin/users",
			strings.NewReader(`{"username":"Alice","email":" alice@example.com ","password":"password-123","isAdmin":null}`),
		),
	)
	if ok {
		t.Fatal("decodeAdminUserCreateBody() ok = true, want false")
	}
	wantMessage := zodValidationMessage(
		zodInvalidFormatIssue(
			[]any{"email"},
			"email",
			zodEmailPatternMessage,
			"Invalid email address",
		),
		zodInvalidTypeIssue([]any{"isAdmin"}, "boolean", "null"),
	)
	expectAlbumValidationError(t, response, wantMessage)
}

func TestDecodeAdminUserCreateBodyMatchesNodeZodFieldErrors(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeAdminUserCreateBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/admin/users",
			strings.NewReader(`{"username":1,"email":true,"password":[],"isAdmin":"false"}`),
		),
	)
	if ok {
		t.Fatal("decodeAdminUserCreateBody() ok = true, want false")
	}
	wantMessage := zodValidationMessage(
		zodInvalidTypeIssue([]any{"username"}, "string", "number"),
		zodInvalidTypeIssue([]any{"email"}, "string", "boolean"),
		zodInvalidTypeIssue([]any{"password"}, "string", "array"),
		zodTooSmallArrayIssue([]any{"password"}, 8, "Too small: expected array to have >=8 items"),
		zodInvalidTypeIssue([]any{"isAdmin"}, "boolean", "string"),
	)
	expectAlbumValidationError(t, response, wantMessage)
}

func TestDecodeAdminUserUpdateBodyRejectsEmptyAndUnknownObjectsLikeNode(t *testing.T) {
	for _, body := range []string{`{}`, `{"unknown":true}`} {
		response := httptest.NewRecorder()
		_, ok := decodeAdminUserUpdateBody(
			response,
			httptest.NewRequest(http.MethodPatch, "/api/admin/users/1", strings.NewReader(body)),
		)
		if ok {
			t.Fatalf("decodeAdminUserUpdateBody(%s) ok = true, want false", body)
		}
		expectAlbumValidationError(
			t,
			response,
			zodValidationMessage(zodCustomIssue([]any{}, "Invalid input")),
		)
	}
}

func TestDecodeAdminUserUpdateBodyMatchesNodeZodFieldErrors(t *testing.T) {
	response := httptest.NewRecorder()
	_, ok := decodeAdminUserUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPatch,
			"/api/admin/users/1",
			strings.NewReader(`{"username":1,"email":true,"password":[],"isAdmin":"false","isActive":0}`),
		),
	)
	if ok {
		t.Fatal("decodeAdminUserUpdateBody() ok = true, want false")
	}
	wantMessage := zodValidationMessage(
		zodInvalidTypeIssue([]any{"username"}, "string", "number"),
		zodInvalidTypeIssue([]any{"email"}, "string", "boolean"),
		zodInvalidTypeIssue([]any{"password"}, "string", "array"),
		zodTooSmallArrayIssue([]any{"password"}, 8, "Too small: expected array to have >=8 items"),
		zodInvalidTypeIssue([]any{"isAdmin"}, "boolean", "string"),
		zodInvalidTypeIssue([]any{"isActive"}, "boolean", "number"),
	)
	expectAlbumValidationError(t, response, wantMessage)

	response = httptest.NewRecorder()
	_, ok = decodeAdminUserUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPatch,
			"/api/admin/users/1",
			strings.NewReader(`{"username":"   ","email":" USER@example.com ","password":"short"}`),
		),
	)
	if ok {
		t.Fatal("decodeAdminUserUpdateBody(bounds) ok = true, want false")
	}
	wantMessage = zodValidationMessage(
		zodTooSmallStringIssue([]any{"username"}, 2),
		zodInvalidFormatIssue(
			[]any{"email"},
			"email",
			zodEmailPatternMessage,
			"Invalid email address",
		),
		zodTooSmallStringIssue([]any{"password"}, 8),
	)
	expectAlbumValidationError(t, response, wantMessage)
}

func TestDecodeAdminUserUpdateBodyTransformsKnownFieldsAndStripsUnknown(t *testing.T) {
	response := httptest.NewRecorder()
	body, ok := decodeAdminUserUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPatch,
			"/api/admin/users/1",
			strings.NewReader(`{"username":"  Alice  ","email":"ALICE@Example.COM","password":"password-123","isAdmin":false,"isActive":true,"unknown":"drop"}`),
		),
	)
	if !ok {
		t.Fatalf("valid admin update rejected: %s", response.Body.String())
	}
	if body.Username == nil || *body.Username != "Alice" ||
		body.Email == nil || *body.Email != "alice@example.com" ||
		body.Password == nil || *body.Password != "password-123" ||
		body.IsAdmin == nil || *body.IsAdmin ||
		body.IsActive == nil || !*body.IsActive {
		t.Fatalf("decoded admin update = %#v, want Node transforms", body)
	}
}

func TestAdminUserPathIDMatchesZodCoercion(t *testing.T) {
	for _, test := range []struct {
		value string
		want  int64
		ok    bool
	}{
		{value: "42", want: 42, ok: true},
		{value: "42.0", want: 42, ok: true},
		{value: "4.2e1", want: 42, ok: true},
		{value: "0x2a", want: 42, ok: true},
		{value: "0b101010", want: 42, ok: true},
		{value: "0o52", want: 42, ok: true},
		{value: "\u00a042\u00a0", want: 42, ok: true},
		{value: "missing", ok: false},
		{value: "1.5", ok: false},
		{value: "0", ok: false},
		{value: "9007199254740992", ok: false},
	} {
		got, ok := adminUserPathID(test.value)
		if ok != test.ok || got != test.want {
			t.Fatalf("adminUserPathID(%q) = %d, %v; want %d, %v", test.value, got, ok, test.want, test.ok)
		}
	}
}

func TestWouldLeaveNoActiveAdmin(t *testing.T) {
	for _, test := range []struct {
		name          string
		currentAdmin  int64
		currentActive int64
		nextAdmin     *bool
		nextActive    *bool
		otherAdmin    bool
		want          bool
	}{
		{
			name:          "demoting only active administrator is blocked",
			currentAdmin:  1,
			currentActive: 1,
			nextAdmin:     boolPointer(false),
			want:          true,
		},
		{
			name:          "disabling only active administrator is blocked",
			currentAdmin:  1,
			currentActive: 1,
			nextActive:    boolPointer(false),
			want:          true,
		},
		{
			name:          "other active administrator keeps account safe",
			currentAdmin:  1,
			currentActive: 1,
			nextAdmin:     boolPointer(false),
			otherAdmin:    true,
			want:          false,
		},
		{
			name:          "inactive administrator is not counted as current active admin",
			currentAdmin:  1,
			currentActive: 0,
			nextAdmin:     boolPointer(false),
			want:          false,
		},
		{
			name:          "non administrator update does not need last admin check",
			currentAdmin:  0,
			currentActive: 1,
			nextActive:    boolPointer(false),
			want:          false,
		},
		{
			name:          "keeping administrator active is allowed",
			currentAdmin:  1,
			currentActive: 1,
			nextAdmin:     boolPointer(true),
			nextActive:    boolPointer(true),
			want:          false,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, store := newWizardTestApplication(t)
			userID := insertAdminUserTestRecord(
				t, store.SQL(), "target", test.currentAdmin, test.currentActive,
			)
			if test.otherAdmin {
				insertAdminUserTestRecord(t, store.SQL(), "other-admin", 1, 1)
			}

			got, err := wouldLeaveNoActiveAdmin(
				context.Background(), store.SQL(), userID,
				test.currentAdmin, test.currentActive, test.nextAdmin, test.nextActive,
			)
			if err != nil {
				t.Fatalf("wouldLeaveNoActiveAdmin() error = %v", err)
			}
			if got != test.want {
				t.Fatalf("wouldLeaveNoActiveAdmin() = %v, want %v", got, test.want)
			}
		})
	}
}

func insertAdminUserTestRecord(
	t *testing.T,
	database *sql.DB,
	name string,
	isAdmin int64,
	isActive int64,
) int64 {
	t.Helper()
	result, err := database.Exec(`
		INSERT INTO users(name,email,password,created_at,is_admin,is_active,auth_version)
		VALUES(?,?,?,?,?,?,1)
	`, name, name+"@example.test", "$2a$10$placeholder", 1_789_137_245, isAdmin, isActive)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func boolPointer(value bool) *bool {
	return &value
}
