package auth

import (
	"errors"
	"testing"
)

func TestInvalidSessionCookiePreservesUnauthorizedClassification(t *testing.T) {
	err := &invalidSessionError{cookieName: "cf_session", secure: true}
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatal("invalid session error must remain an unauthorized error")
	}
	name, secure, ok := InvalidSessionCookie(err)
	if !ok || name != "cf_session" || !secure {
		t.Fatalf("InvalidSessionCookie() = %q, %v, %v", name, secure, ok)
	}
	if _, _, ok := InvalidSessionCookie(ErrUnauthorized); ok {
		t.Fatal("a request without a rejected cookie must not clear a cookie")
	}
}
