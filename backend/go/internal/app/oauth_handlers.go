package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
)

const githubOAuthStateCookie = "nuxt-auth-state"

type githubUser struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	AvatarURL string `json:"avatar_url"`
}

type githubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

// githubOAuth is a standard-library implementation of the same OAuth flow as
// the Node handler. The callback is intentionally owned by whichever backend
// is selected, and the resulting identity is committed to the shared users
// table before a shared Redis session is issued.
func (a *Application) githubOAuth(w http.ResponseWriter, r *http.Request) {
	if a.settings == nil || a.auth == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		return
	}

	enabled, _ := a.settings.Value(r.Context(), "system", "auth.github.enabled")
	isEnabled, _ := settings.BooleanValue(enabled.Value)
	if !isEnabled {
		httpx.Error(w, http.StatusForbidden, "GitHub OAuth login is disabled.")
		return
	}
	clientID := a.settingString(r.Context(), "system", "auth.github.clientId")
	clientSecret := a.settingString(r.Context(), "system", "auth.github.clientSecret")
	if clientID == "" {
		clientID = strings.TrimSpace(getenv("NUXT_OAUTH_GITHUB_CLIENT_ID"))
	}
	if clientSecret == "" {
		clientSecret = strings.TrimSpace(getenv("NUXT_OAUTH_GITHUB_CLIENT_SECRET"))
	}
	if clientID == "" || clientSecret == "" {
		httpx.Error(w, http.StatusInternalServerError,
			"GitHub OAuth is enabled but credentials are missing in system settings.")
		return
	}

	callback := requestOrigin(r) + r.URL.Path
	query := r.URL.Query()
	if nodeQueryTruthy(query, "error") {
		githubAuthenticationError(w, "GitHub login failed: "+nodeQueryString(query, "error"))
		return
	}

	var state *string
	if nodeQueryTruthy(query, "state") {
		if stateCookie, err := r.Cookie(githubOAuthStateCookie); err == nil {
			state = &stateCookie.Value
		}
		clearOAuthStateCookie(w)
	} else {
		generatedState, err := randomOAuthState()
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "Authentication failed")
			return
		}
		state = &generatedState
		setOAuthStateCookie(w, generatedState, a.config.OAuthCookieSecure)
	}

	if !nodeQueryTruthy(query, "code") {
		sendH3Redirect(w, githubAuthorizeURL(clientID, callback, state), http.StatusFound)
		return
	}

	if state == nil || nodeQueryIsArray(query, "state") || nodeQueryString(query, "state") != *state {
		githubAuthenticationError(w, "Github login failed: state mismatch")
		return
	}

	code := nodeQueryString(query, "code")
	token, err := exchangeGithubCode(r.Context(), clientID, clientSecret, code, callback)
	if err != nil {
		githubAuthenticationError(w, err.Error())
		return
	}
	profile, err := fetchGithubIdentity(r.Context(), token, clientID)
	if err != nil {
		githubAuthenticationError(w, err.Error())
		return
	}

	email := strings.ToLower(strings.TrimSpace(profile.Email))
	if email == "" {
		emails, emailErr := fetchGithubEmails(r.Context(), token, clientID)
		if emailErr == nil {
			email = primaryGithubEmail(emails)
		} else {
			githubAuthenticationError(w, emailErr.Error())
			return
		}
	}
	if email == "" {
		githubAuthenticationError(w, "Could not get GitHub user email")
		return
	}

	identities, ok := a.auth.IdentityRepository()
	if !ok {
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		return
	}
	user, findErr := identities.FindByEmail(r.Context(), email)
	if errors.Is(findErr, auth.ErrUnauthorized) {
		username := profile.Name
		avatar := profile.AvatarURL
		user, findErr = identities.Create(r.Context(), auth.User{
			Username: username,
			Email:    email,
			Avatar:   stringPtrOrNil(avatar),
			IsAdmin:  0,
			IsActive: true,
		}, "")
		if findErr != nil {
			a.logger.ErrorContext(r.Context(), "GitHub OAuth user creation failed", "error", findErr)
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		// Match Node's onboarding policy: an unknown GitHub identity is
		// provisioned but cannot log in until an administrator activates it.
		httpx.Error(w, http.StatusForbidden,
			"Access denied. Please contact the administrator to activate your account.")
		return
	}
	if findErr != nil {
		a.logger.ErrorContext(r.Context(), "GitHub OAuth user lookup failed", "error", findErr)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if !user.IsActive || user.IsAdmin == 0 {
		httpx.Error(w, http.StatusForbidden,
			"Access denied. Please contact the administrator to activate your account.")
		return
	}

	store := a.auth.SessionStore()
	if store == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		return
	}
	sessionToken, err := issueSession(r.Context(), store, user, a.now())
	if err != nil {
		if errors.Is(err, redisx.ErrUnavailable) {
			httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
		} else {
			httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
		}
		return
	}
	setCookie(w, r, a.auth.SessionCookieName(), sessionToken, int(sharedSessionTTL/time.Second))
	sendH3Redirect(w, "/", http.StatusFound)
}

func (a *Application) settingString(
	ctx context.Context,
	namespace string,
	key string,
) string {
	if a.settings == nil {
		return ""
	}
	row, err := a.settings.Value(ctx, namespace, key)
	if err != nil || !row.Value.Valid {
		return ""
	}
	return strings.TrimSpace(row.Value.String)
}

func randomOAuthState() (string, error) {
	value := make([]byte, 8)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func setOAuthStateCookie(w http.ResponseWriter, value string, secure bool) {
	cookie := githubOAuthStateCookie + "=" + value + "; Max-Age=600; Path=/; HttpOnly"
	if secure {
		cookie += "; Secure"
	}
	w.Header().Add("Set-Cookie", cookie+"; SameSite=Lax")
}

func clearOAuthStateCookie(w http.ResponseWriter) {
	w.Header().Add("Set-Cookie", githubOAuthStateCookie+"=; Max-Age=0; Path=/")
}

func githubAuthenticationError(w http.ResponseWriter, message string) {
	if strings.TrimSpace(message) == "" {
		message = "Unknown error"
	}
	httpx.Error(w, http.StatusUnauthorized, "Authentication failed: "+message)
}

func githubAuthorizeURL(clientID, redirectURI string, state *string) string {
	parts := []string{
		"client_id=" + ufoQueryEscape(clientID),
		"redirect_uri=" + ufoQueryEscape(redirectURI),
		"scope=" + ufoQueryEscape("user:email"),
	}
	if state != nil {
		if *state == "" {
			parts = append(parts, "state")
		} else {
			parts = append(parts, "state="+ufoQueryEscape(*state))
		}
	}
	return "https://github.com/login/oauth/authorize?" + strings.Join(parts, "&")
}

func ufoQueryEscape(value string) string {
	const hexadecimal = "0123456789ABCDEF"
	var encoded strings.Builder
	for _, character := range []byte(value) {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			strings.ContainsRune(";,?:@=$-_.!~*'()`^|", rune(character)) {
			encoded.WriteByte(character)
			continue
		}
		if character == ' ' {
			encoded.WriteByte('+')
			continue
		}
		encoded.WriteByte('%')
		encoded.WriteByte(hexadecimal[character>>4])
		encoded.WriteByte(hexadecimal[character&15])
	}
	return encoded.String()
}

func formQueryEscape(value string) string {
	const hexadecimal = "0123456789ABCDEF"
	var encoded strings.Builder
	for _, character := range []byte(value) {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			strings.ContainsRune("*-._", rune(character)) {
			encoded.WriteByte(character)
			continue
		}
		if character == ' ' {
			encoded.WriteByte('+')
			continue
		}
		encoded.WriteByte('%')
		encoded.WriteByte(hexadecimal[character>>4])
		encoded.WriteByte(hexadecimal[character&15])
	}
	return encoded.String()
}

func sendH3Redirect(w http.ResponseWriter, location string, status int) {
	w.Header().Set("Location", location)
	w.Header().Set("Content-Type", "text/html")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=`+
		strings.ReplaceAll(location, `"`, "%22")+`"></head></html>`)
}

func exchangeGithubCode(
	ctx context.Context,
	clientID string,
	clientSecret string,
	code string,
	redirectURI string,
) (string, error) {
	body := "grant_type=authorization_code" +
		"&client_id=" + formQueryEscape(clientID) +
		"&client_secret=" + formQueryEscape(clientSecret) +
		"&redirect_uri=" + formQueryEscape(redirectURI) +
		"&code=" + formQueryEscape(code)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		githubOAuthTokenURL,
		strings.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := oauthHTTPClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized &&
		(response.StatusCode < 200 || response.StatusCode >= 300) {
		return "", fmt.Errorf("github token exchange returned %d", response.StatusCode)
	}
	var payload struct {
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return "", err
	}
	if payload.Error != "" {
		message := payload.Error
		if payload.ErrorDescription != "" {
			message = payload.ErrorDescription
		}
		return "", errors.New("Github login failed: " + message)
	}
	if payload.AccessToken == "" {
		return "", errors.New("Github login failed: Unknown error")
	}
	return payload.AccessToken, nil
}

func fetchGithubIdentity(ctx context.Context, token, clientID string) (githubUser, error) {
	var profile githubUser
	if err := githubJSONRequest(ctx, token, clientID, githubAPIURL+"/user", &profile); err != nil {
		return githubUser{}, err
	}
	return profile, nil
}

func fetchGithubEmails(ctx context.Context, token, clientID string) ([]githubEmail, error) {
	var emails []githubEmail
	if err := githubJSONRequest(ctx, token, clientID, githubAPIURL+"/user/emails", &emails); err != nil {
		return nil, err
	}
	return emails, nil
}

func githubJSONRequest(ctx context.Context, token, clientID, endpoint string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "Github-OAuth-"+clientID)
	request.Header.Set("Authorization", "token "+token)
	response, err := oauthHTTPClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("github API returned %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(target)
}

func primaryGithubEmail(emails []githubEmail) string {
	for _, item := range emails {
		if item.Primary {
			return strings.ToLower(strings.TrimSpace(item.Email))
		}
	}
	return ""
}

var (
	githubOAuthTokenURL = "https://github.com/login/oauth/access_token"
	githubAPIURL        = "https://api.github.com"
	oauthHTTPClient     = &http.Client{Timeout: 15 * time.Second}
)

func stringPtrOrNil(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func getenv(name string) string {
	return strings.TrimSpace(os.Getenv(name))
}
