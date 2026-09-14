package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	platformconfig "github.com/swzyt/chronoframe/backend/go/internal/platform/config"
)

func TestDecodeLoginBodyMatchesNodeZodValidation(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "missing body", body: ``},
		{name: "missing fields", body: `{}`},
		{name: "invalid email", body: `{"email":"not-an-email","password":"secret1"}`},
		{name: "email is not trimmed before zod validation", body: `{"email":" user@example.com ","password":"secret1"}`},
		{name: "password too short", body: `{"email":"user@example.com","password":"12345"}`},
		{name: "email must be string", body: `{"email":42,"password":"secret1"}`},
		{name: "password must be string", body: `{"email":"user@example.com","password":42}`},
		{name: "email null is not a string", body: `{"email":null,"password":"secret1"}`},
		{name: "password null is not a string", body: `{"email":"user@example.com","password":null}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodeLoginBody(
				response,
				httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodeLoginBody() ok = true, want false")
			}
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), `"statusMessage":"Validation Error"`) {
				t.Fatalf("body = %s, want Validation Error", response.Body.String())
			}
		})
	}

	response := httptest.NewRecorder()
	body, ok := decodeLoginBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/login",
			strings.NewReader(`{"email":"USER@Example.COM","password":"secret1"}`),
		),
	)
	if !ok {
		t.Fatalf("valid login body rejected: %s", response.Body.String())
	}
	if body.Email != "user@example.com" || body.Password != "secret1" {
		t.Fatalf("decodeLoginBody() = %#v, want normalized email and original password", body)
	}
}

func TestLoginInvalidCredentialsMatchesNodeErrorEnvelope(t *testing.T) {
	t.Setenv("CFRAME_RATE_LIMIT_SECRET", "rate-limit-secret-0123456789abcdef")
	_, store := newWizardTestApplication(t)
	application := &Application{
		config: platformconfig.Config{Environment: "test"},
		redis:  &fakeLoginRateLimitStore{allowed: true},
		auth: auth.NewService(
			auth.NewSQLiteRepository(store.SQL()),
			nil,
			"cf_session",
		),
		now: func() time.Time { return time.Unix(1_788_940_800, 0).UTC() },
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/login",
		strings.NewReader(`{"email":"missing@example.com","password":"invalid-password"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	application.login(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"statusMessage":"Server Error"`) ||
		!strings.Contains(response.Body.String(), `"message":"Invalid credentials"`) {
		t.Fatalf("body = %s, want Node-compatible invalid credentials error", response.Body.String())
	}
}

func TestBuildRateLimitKeyMatchesNodeGoldenVector(t *testing.T) {
	key, windowExpiresAt, err := buildRateLimitKey(rateLimitKeyInput{
		Environment:   "test",
		Purpose:       "login",
		Subject:       "203.0.113.9:" + strings.Repeat("attacker-input", 100),
		NowSeconds:    1_788_940_800,
		WindowSeconds: 900,
		Secret:        []byte("rate-limit-secret-0123456789abcdef"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if key != "cf:v1:test:ratelimit:login:6f69aa430fd3a4a03f8b8db4dd565f80928298c4031dec2d322054d1e6e9aa70:1987712" {
		t.Fatalf("key = %q", key)
	}
	if windowExpiresAt != 1_788_941_700 {
		t.Fatalf("windowExpiresAt = %d, want 1788941700", windowExpiresAt)
	}
}

func TestRateLimitSecretDerivesFromSessionPasswordLikeNode(t *testing.T) {
	t.Setenv("CFRAME_RATE_LIMIT_SECRET", "")
	t.Setenv("NUXT_SESSION_PASSWORD", "session-secret-0123456789abcdefXX")
	secret, err := rateLimitSecret()
	if err != nil {
		t.Fatal(err)
	}
	key, _, err := buildRateLimitKey(rateLimitKeyInput{
		Environment:   "test",
		Purpose:       "login",
		Subject:       "203.0.113.9\x00victim@example.com",
		NowSeconds:    1_788_940_800,
		WindowSeconds: 900,
		Secret:        secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if key != "cf:v1:test:ratelimit:login:6680e8521861d1dc186200c4274b54a2371242c069649d13413e95a07a316ca3:1987712" {
		t.Fatalf("derived key = %q", key)
	}
}

func TestAcquireAndResetLoginRateLimitUseSharedNodeSubject(t *testing.T) {
	t.Setenv("CFRAME_RATE_LIMIT_SECRET", "rate-limit-secret-0123456789abcdef")
	rateLimiter := &fakeLoginRateLimitStore{allowed: true, count: 1, retryAfter: 900}
	application := &Application{
		config: platformconfig.Config{Environment: "test"},
		redis:  rateLimiter,
		now:    func() time.Time { return time.Unix(1_788_940_800, 0).UTC() },
	}
	request := httptest.NewRequest(http.MethodPost, "/api/login", nil)
	request.Header.Set("X-Forwarded-For", "203.0.113.9")

	decision, err := application.acquireLoginRateLimit(context.Background(), request, " Victim@Example.COM ")
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Allowed || decision.Count != 1 || decision.RetryAfterSeconds != 900 {
		t.Fatalf("decision = %#v", decision)
	}
	if rateLimiter.key != "cf:v1:test:ratelimit:login:44290aacc62e403ac21a186b9352f60a93b32b34778fb07e74ceabe0e8864502:1987712" {
		t.Fatalf("rate limit key = %q", rateLimiter.key)
	}
	if rateLimiter.maxAttempts != authRateLimitMaxAttempts {
		t.Fatalf("maxAttempts = %d, want %d", rateLimiter.maxAttempts, authRateLimitMaxAttempts)
	}
	if rateLimiter.windowExpiresAt != 1_788_941_700 {
		t.Fatalf("windowExpiresAt = %d, want 1788941700", rateLimiter.windowExpiresAt)
	}

	if err := application.resetLoginRateLimit(context.Background(), decision); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rateLimiter.resetKeys, []string{decision.Key}) {
		t.Fatalf("resetKeys = %#v, want %#v", rateLimiter.resetKeys, []string{decision.Key})
	}
}

func TestDecodeAccessVerifyBodyMatchesNodeZodValidation(t *testing.T) {
	longPasswordBody := `{"password":"` + strings.Repeat("x", 129) + `"}`
	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{name: "missing body", body: ``, want: "expected object"},
		{name: "missing password", body: `{}`, want: "invalid_type"},
		{name: "empty password", body: `{"password":""}`, want: "too_small"},
		{name: "too long password", body: longPasswordBody, want: "too_big"},
		{name: "password must be string", body: `{"password":42}`, want: "invalid_type"},
		{name: "password null is rejected", body: `{"password":null}`, want: "null"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodeAccessVerifyBody(
				response,
				httptest.NewRequest(http.MethodPost, "/api/access/verify", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodeAccessVerifyBody() ok = true, want false")
			}
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), `"statusMessage":"Validation Error"`) ||
				!strings.Contains(response.Body.String(), test.want) {
				t.Fatalf("body = %s, want Validation Error with %s", response.Body.String(), test.want)
			}
		})
	}

	response := httptest.NewRecorder()
	body, ok := decodeAccessVerifyBody(
		response,
		httptest.NewRequest(http.MethodPost, "/api/access/verify", strings.NewReader(`{"password":"site-secret"}`)),
	)
	if !ok {
		t.Fatalf("valid access body rejected: %s", response.Body.String())
	}
	if body.Password != "site-secret" {
		t.Fatalf("decodeAccessVerifyBody() = %#v, want original password", body)
	}
}

func TestDecodeAccessConfigUpdateBodyMatchesNodeZodValidation(t *testing.T) {
	longPasswordBody := `{"enabled":true,"password":"` + strings.Repeat("x", 129) + `","photoLimit":1,"albumLimit":1}`
	for _, test := range []struct {
		name string
		body string
		want string
	}{
		{name: "missing fields", body: `{}`, want: "invalid_type"},
		{name: "missing enabled", body: `{"photoLimit":1,"albumLimit":1}`, want: "enabled"},
		{name: "enabled must be boolean", body: `{"enabled":"false","photoLimit":1,"albumLimit":1}`, want: "boolean"},
		{name: "password null is rejected", body: `{"enabled":true,"password":null,"photoLimit":1,"albumLimit":1}`, want: "null"},
		{name: "password too short", body: `{"enabled":true,"password":"short","photoLimit":1,"albumLimit":1}`, want: "too_small"},
		{name: "password too long", body: longPasswordBody, want: "too_big"},
		{name: "photo limit must be int", body: `{"enabled":true,"photoLimit":1.5,"albumLimit":1}`, want: "safeint"},
		{name: "photo limit too small", body: `{"enabled":true,"photoLimit":0,"albumLimit":1}`, want: "too_small"},
		{name: "album limit too big", body: `{"enabled":true,"photoLimit":1,"albumLimit":10001}`, want: "too_big"},
		{name: "limit string is rejected", body: `{"enabled":true,"photoLimit":"1","albumLimit":1}`, want: "string"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodeAccessConfigUpdateBody(
				response,
				httptest.NewRequest(http.MethodPut, "/api/access/config", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodeAccessConfigUpdateBody() ok = true, want false")
			}
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), `"statusMessage":"Validation Error"`) ||
				!strings.Contains(response.Body.String(), test.want) {
				t.Fatalf("body = %s, want Validation Error with %s", response.Body.String(), test.want)
			}
		})
	}

	response := httptest.NewRecorder()
	body, ok := decodeAccessConfigUpdateBody(
		response,
		httptest.NewRequest(
			http.MethodPut,
			"/api/access/config",
			strings.NewReader(`{"enabled":false,"photoLimit":1.0,"albumLimit":10000}`),
		),
	)
	if !ok {
		t.Fatalf("valid access config body rejected: %s", response.Body.String())
	}
	if body.Enabled || body.Password != nil || body.PhotoLimit != 1 || body.AlbumLimit != 10000 {
		t.Fatalf("decodeAccessConfigUpdateBody() = %#v, want Node-compatible parsed fields", body)
	}
}

func TestAcquireAndResetAccessRateLimitUseSharedNodeSubject(t *testing.T) {
	t.Setenv("CFRAME_RATE_LIMIT_SECRET", "rate-limit-secret-0123456789abcdef")
	rateLimiter := &fakeLoginRateLimitStore{allowed: true, count: 1, retryAfter: 900}
	application := &Application{
		config: platformconfig.Config{Environment: "test"},
		redis:  rateLimiter,
		now:    func() time.Time { return time.Unix(1_788_940_800, 0).UTC() },
	}
	request := httptest.NewRequest(http.MethodPost, "/api/access/verify", nil)
	request.Header.Set("X-Forwarded-For", "203.0.113.9")

	decision, err := application.acquireAccessRateLimit(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Allowed || decision.Count != 1 || decision.RetryAfterSeconds != 900 {
		t.Fatalf("decision = %#v", decision)
	}
	if rateLimiter.key != "cf:v1:test:ratelimit:access:97cde27b0cdb354e1fb14277e494bedc7cf38ff6e14eb4b449c1a14d4c8fd01b:1987712" {
		t.Fatalf("rate limit key = %q", rateLimiter.key)
	}
	if rateLimiter.maxAttempts != authRateLimitMaxAttempts {
		t.Fatalf("maxAttempts = %d, want %d", rateLimiter.maxAttempts, authRateLimitMaxAttempts)
	}
	if rateLimiter.windowExpiresAt != 1_788_941_700 {
		t.Fatalf("windowExpiresAt = %d, want 1788941700", rateLimiter.windowExpiresAt)
	}

	if err := application.resetAccessRateLimit(context.Background(), decision); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rateLimiter.resetKeys, []string{decision.Key}) {
		t.Fatalf("resetKeys = %#v, want %#v", rateLimiter.resetKeys, []string{decision.Key})
	}
}

func TestAcquireLoginRateLimitRequiresSharedStoreAndSecret(t *testing.T) {
	t.Setenv("CFRAME_RATE_LIMIT_SECRET", "")
	t.Setenv("NUXT_SESSION_PASSWORD", "")
	application := &Application{
		config: platformconfig.Config{Environment: "test"},
		redis:  &fakeLoginRateLimitStore{allowed: true},
		now:    func() time.Time { return time.Unix(1_788_940_800, 0).UTC() },
	}
	request := httptest.NewRequest(http.MethodPost, "/api/login", nil)

	if _, err := application.acquireLoginRateLimit(context.Background(), request, "user@example.com"); err == nil {
		t.Fatal("acquireLoginRateLimit() error = nil, want missing secret error")
	}
	application.redis = nil
	t.Setenv("CFRAME_RATE_LIMIT_SECRET", "rate-limit-secret-0123456789abcdef")
	if _, err := application.acquireLoginRateLimit(context.Background(), request, "user@example.com"); err == nil {
		t.Fatal("acquireLoginRateLimit() error = nil, want missing store error")
	}
}

func TestLogoutClearsSharedAndLegacySessionCookies(t *testing.T) {
	application := &Application{
		auth: auth.NewService(nil, nil, "cf_session"),
	}
	request := httptest.NewRequest(http.MethodGet, "/api/logout", nil)
	request.Header.Set("Cookie", "cf_session=shared-token; nuxt-session=legacy-token")
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()

	application.logout(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if body := response.Body.String(); body != "{\"success\":true}\n" {
		t.Fatalf("body = %s, want Node-compatible logout body", body)
	}
	cookies := response.Result().Cookies()
	cleared := map[string]*http.Cookie{}
	for _, cookie := range cookies {
		if cookie.MaxAge < 0 || cookie.Value == "" {
			cleared[cookie.Name] = cookie
		}
	}
	for _, name := range []string{"cf_session", legacySessionCookieName} {
		cookie := cleared[name]
		if cookie == nil {
			t.Fatalf("cleared cookies = %#v, want %s", cleared, name)
		}
		if cookie.Path != "/" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || !cookie.Secure {
			t.Fatalf("cookie %s = %#v, want Node-compatible deletion attributes", name, cookie)
		}
	}
}

func TestAuthSessionDeleteClearsSharedAndLegacySessionCookies(t *testing.T) {
	application := &Application{
		auth: auth.NewService(nil, nil, "cf_session"),
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/_auth/session", nil)
	request.Header.Set("Cookie", "cf_session=shared-token; nuxt-session=legacy-token")
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()

	application.authSessionDelete(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if body := response.Body.String(); body != "{\"loggedOut\":true}\n" {
		t.Fatalf("body = %s, want Node-compatible auth session delete body", body)
	}
	cookies := response.Result().Cookies()
	cleared := map[string]*http.Cookie{}
	for _, cookie := range cookies {
		if cookie.MaxAge < 0 || cookie.Value == "" {
			cleared[cookie.Name] = cookie
		}
	}
	for _, name := range []string{"cf_session", legacySessionCookieName} {
		cookie := cleared[name]
		if cookie == nil {
			t.Fatalf("cleared cookies = %#v, want %s", cleared, name)
		}
		if cookie.Path != "/" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || !cookie.Secure {
			t.Fatalf("cookie %s = %#v, want Node-compatible deletion attributes", name, cookie)
		}
	}
}

func TestAnonymousAuthSessionMatchesNodeShape(t *testing.T) {
	application := &Application{
		auth: auth.NewService(nil, nil, "cf_session"),
	}
	request := httptest.NewRequest(http.MethodGet, "/api/_auth/session", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()

	application.authSession(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if body := response.Body.String(); !strings.Contains(body, `"id":"`) {
		t.Fatalf("body = %s, want anonymous session id", body)
	}
	cookies := response.Result().Cookies()
	cleared := map[string]*http.Cookie{}
	for _, cookie := range cookies {
		if cookie.MaxAge < 0 || cookie.Value == "" {
			cleared[cookie.Name] = cookie
		}
	}
	for _, name := range []string{"cf_session", legacySessionCookieName} {
		cookie := cleared[name]
		if cookie == nil {
			t.Fatalf("cleared cookies = %#v, want %s", cleared, name)
		}
		if cookie.Path != "/" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || !cookie.Secure {
			t.Fatalf("cookie %s = %#v, want Node-compatible session attributes", name, cookie)
		}
	}
}

type fakeLoginRateLimitStore struct {
	allowed         bool
	count           int64
	retryAfter      int64
	err             error
	key             string
	maxAttempts     int64
	windowExpiresAt int64
	resetKeys       []string
}

func (f *fakeLoginRateLimitStore) Ping(context.Context) error {
	return nil
}

func (f *fakeLoginRateLimitStore) GetString(context.Context, string) (string, error) {
	return "", errors.New("not implemented")
}

func (f *fakeLoginRateLimitStore) AcquireRateLimit(_ context.Context, key string, maxAttempts int64, windowExpiresAt int64) (bool, int64, int64, error) {
	f.key = key
	f.maxAttempts = maxAttempts
	f.windowExpiresAt = windowExpiresAt
	return f.allowed, f.count, f.retryAfter, f.err
}

func (f *fakeLoginRateLimitStore) ResetRateLimit(_ context.Context, key string) error {
	f.resetKeys = append(f.resetKeys, key)
	return f.err
}
