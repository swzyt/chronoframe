package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const (
	defaultScryptN       = 16384
	defaultScryptR       = 8
	defaultScryptP       = 1
	defaultScryptSaltLen = 16
	defaultScryptKeyLen  = 64
	maxScryptN           = 1 << 20
	maxScryptR           = 32
	maxScryptP           = 8
)

// HashPassword emits the AdonisJS scrypt PHC format used by Node.
func HashPassword(password string) (string, error) {
	salt := make([]byte, defaultScryptSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	derived, err := scrypt.Key(
		[]byte(password),
		salt,
		defaultScryptN,
		defaultScryptR,
		defaultScryptP,
		defaultScryptKeyLen,
	)
	if err != nil {
		return "", fmt.Errorf("derive password hash: %w", err)
	}
	encoding := base64.RawStdEncoding
	return fmt.Sprintf(
		"$scrypt$n=%d,r=%d,p=%d$%s$%s",
		defaultScryptN,
		defaultScryptR,
		defaultScryptP,
		encoding.EncodeToString(salt),
		encoding.EncodeToString(derived),
	), nil
}

// VerifyPassword accepts the existing Node PHC representation and rejects
// malformed or resource-exhausting parameters before deriving a key.
func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "" || parts[1] != "scrypt" {
		return false
	}
	params := map[string]int{}
	for _, item := range strings.Split(parts[2], ",") {
		name, raw, ok := strings.Cut(item, "=")
		if !ok || name == "" {
			return false
		}
		value, err := strconv.Atoi(raw)
		if err != nil {
			return false
		}
		params[name] = value
	}
	n, r, p := params["n"], params["r"], params["p"]
	if n < 2 || n > maxScryptN || n&(n-1) != 0 ||
		r < 1 || r > maxScryptR ||
		p < 1 || p > maxScryptP ||
		int64(128)*int64(n)*int64(r) >= 32*1024*1024 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil || len(salt) < 8 || len(salt) > 1024 {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(expected) < 64 || len(expected) > 128 {
		return false
	}
	derived, err := scrypt.Key([]byte(password), salt, n, r, p, len(expected))
	if err != nil || len(derived) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare(derived, expected) == 1
}

var ErrPasswordHashInvalid = errors.New("invalid password hash")
