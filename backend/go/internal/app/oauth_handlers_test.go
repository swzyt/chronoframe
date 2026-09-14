package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRandomOAuthStateMatchesNuxtAuthUtilsSize(t *testing.T) {
	state, err := randomOAuthState()
	if err != nil {
		t.Fatalf("randomOAuthState() error = %v", err)
	}
	if len(state) != 11 {
		t.Fatalf("state length = %d, want 11", len(state))
	}
	decoded, err := base64.RawURLEncoding.DecodeString(state)
	if err != nil {
		t.Fatalf("decode state: %v", err)
	}
	if len(decoded) != 8 {
		t.Fatalf("decoded state length = %d, want 8", len(decoded))
	}
}

func TestOAuthStateCookieMatchesH3Serialization(t *testing.T) {
	for _, test := range []struct {
		name   string
		secure bool
		want   string
	}{
		{
			name:   "production",
			secure: true,
			want:   "nuxt-auth-state=fixed-state; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
		},
		{
			name:   "development",
			secure: false,
			want:   "nuxt-auth-state=fixed-state; Max-Age=600; Path=/; HttpOnly; SameSite=Lax",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			setOAuthStateCookie(response, "fixed-state", test.secure)
			if got := response.Header().Get("Set-Cookie"); got != test.want {
				t.Fatalf("Set-Cookie = %q, want %q", got, test.want)
			}
		})
	}

	response := httptest.NewRecorder()
	clearOAuthStateCookie(response)
	if got, want := response.Header().Get("Set-Cookie"), "nuxt-auth-state=; Max-Age=0; Path=/"; got != want {
		t.Fatalf("clear Set-Cookie = %q, want %q", got, want)
	}
}

func TestGithubAuthorizeURLMatchesUFO(t *testing.T) {
	state := "fixed_state"
	got := githubAuthorizeURL(
		"client id",
		"http://127.0.0.1:33121/api/auth/github",
		&state,
	)
	want := "https://github.com/login/oauth/authorize?" +
		"client_id=client+id" +
		"&redirect_uri=http:%2F%2F127.0.0.1:33121%2Fapi%2Fauth%2Fgithub" +
		"&scope=user:email" +
		"&state=fixed_state"
	if got != want {
		t.Fatalf("authorize URL = %q, want %q", got, want)
	}

	if got := githubAuthorizeURL("client", "http://callback", nil); strings.Contains(got, "state") {
		t.Fatalf("undefined state should be omitted: %q", got)
	}
	empty := ""
	if got := githubAuthorizeURL("client", "http://callback", &empty); !strings.HasSuffix(got, "&state") {
		t.Fatalf("empty state should be serialized as a bare key: %q", got)
	}
}

func TestOAuthQueryEncodersMatchNodeLibraries(t *testing.T) {
	if got, want := ufoQueryEscape("http://a/b?x=hello world&y=+$#^|`你"),
		"http:%2F%2Fa%2Fb?x=hello+world%26y=%2B$%23^|`%E4%BD%A0"; got != want {
		t.Fatalf("ufoQueryEscape() = %q, want %q", got, want)
	}
	if got, want := formQueryEscape("a ~!*'()你"), "a+%7E%21*%27%28%29%E4%BD%A0"; got != want {
		t.Fatalf("formQueryEscape() = %q, want %q", got, want)
	}
}

func TestSendH3RedirectMatchesNodeBody(t *testing.T) {
	response := httptest.NewRecorder()
	sendH3Redirect(response, `https://example.test/path?value="quoted"`, http.StatusFound)

	if response.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "text/html" {
		t.Fatalf("Content-Type = %q, want text/html", got)
	}
	if got, want := response.Header().Get("Location"), `https://example.test/path?value="quoted"`; got != want {
		t.Fatalf("Location = %q, want %q", got, want)
	}
	wantBody := `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=https://example.test/path?value=%22quoted%22"></head></html>`
	if got := response.Body.String(); got != wantBody {
		t.Fatalf("body = %q, want %q", got, wantBody)
	}
}

func TestGithubJSONRequestMatchesNuxtAuthHeaders(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got, want := r.Header.Get("User-Agent"), "Github-OAuth-client-id"; got != want {
			t.Errorf("User-Agent = %q, want %q", got, want)
		}
		if got, want := r.Header.Get("Authorization"), "token access-token"; got != want {
			t.Errorf("Authorization = %q, want %q", got, want)
		}
		if got := r.Header.Get("X-GitHub-Api-Version"); got != "" {
			t.Errorf("X-GitHub-Api-Version = %q, want empty", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":42}`)
	}))
	defer server.Close()

	originalClient := oauthHTTPClient
	oauthHTTPClient = server.Client()
	t.Cleanup(func() { oauthHTTPClient = originalClient })

	var result map[string]any
	if err := githubJSONRequest(context.Background(), "access-token", "client-id", server.URL, &result); err != nil {
		t.Fatalf("githubJSONRequest() error = %v", err)
	}
	if result["id"] != float64(42) {
		t.Fatalf("decoded result = %#v", result)
	}
}

func TestExchangeGithubCodeMatchesURLSearchParamsAndOAuthErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		wantBody := "grant_type=authorization_code&client_id=client+id&client_secret=secret%7E&redirect_uri=http%3A%2F%2Fcallback%2Fpath&code=one%2Ctwo"
		if got := string(body); got != wantBody {
			t.Errorf("body = %q, want %q", got, wantBody)
		}
		if got, want := r.Header.Get("Content-Type"), "application/x-www-form-urlencoded"; got != want {
			t.Errorf("Content-Type = %q, want %q", got, want)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":             "bad_verification_code",
			"error_description": "The code passed is incorrect or expired.",
		})
	}))
	defer server.Close()

	originalURL, originalClient := githubOAuthTokenURL, oauthHTTPClient
	githubOAuthTokenURL, oauthHTTPClient = server.URL, server.Client()
	t.Cleanup(func() {
		githubOAuthTokenURL, oauthHTTPClient = originalURL, originalClient
	})

	_, err := exchangeGithubCode(
		context.Background(), "client id", "secret~", "one,two", "http://callback/path",
	)
	if err == nil || err.Error() != "Github login failed: The code passed is incorrect or expired." {
		t.Fatalf("exchange error = %v", err)
	}
}

func TestPrimaryGithubEmailUsesFirstPrimaryWithoutVerifiedFallback(t *testing.T) {
	emails := []githubEmail{
		{Email: "fallback@example.test", Verified: true},
		{Email: " PRIMARY@Example.Test ", Primary: true, Verified: false},
		{Email: "later@example.test", Primary: true, Verified: true},
	}
	if got, want := primaryGithubEmail(emails), "primary@example.test"; got != want {
		t.Fatalf("primaryGithubEmail() = %q, want %q", got, want)
	}
	if got := primaryGithubEmail(emails[:1]); got != "" {
		t.Fatalf("non-primary fallback = %q, want empty", got)
	}
}

func TestGithubProfileOptionalStringsMatchJavaScriptTruthyValues(t *testing.T) {
	if got := stringPtrOrNil(""); got != nil {
		t.Fatalf("empty avatar = %q, want nil", *got)
	}
	if got := stringPtrOrNil("   "); got == nil || *got != "   " {
		t.Fatalf("whitespace avatar = %#v, want original value", got)
	}
}
