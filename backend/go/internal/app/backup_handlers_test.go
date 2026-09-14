package app

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/scrypt"
)

func TestBackupRunReportsServiceUnavailableWhenDependenciesAreMissing(t *testing.T) {
	response := httptest.NewRecorder()
	NewApplication(Dependencies{}).backupRun(
		response,
		httptest.NewRequest(http.MethodPost, "/api/system/backup/run", nil),
	)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"statusMessage":"Service Unavailable"`) {
		t.Fatalf("body = %s, want Service Unavailable error", response.Body.String())
	}
}

func TestBackupRecipientParserMatchesNodeDelimiters(t *testing.T) {
	got := parseBackupRecipients("a@example.com, b@example.com\nc@example.com; ;")
	want := []string{"a@example.com", "b@example.com", "c@example.com"}
	if len(got) != len(want) {
		t.Fatalf("parseBackupRecipients() = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("parseBackupRecipients()[%d] = %q, want %q", index, got[index], want[index])
		}
	}
}

func TestBackupEncryptionUsesChronoFrameV2Envelope(t *testing.T) {
	tempDir := t.TempDir()
	sourcePath := filepath.Join(tempDir, "backup.sqlite3.gz")
	targetPath := sourcePath + ".enc"
	plain := []byte("sqlite backup gzip bytes")
	if err := os.WriteFile(sourcePath, plain, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := encryptBackupFile(sourcePath, targetPath, "correct horse battery staple"); err != nil {
		t.Fatal(err)
	}
	encrypted, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(encrypted, backupMagic) {
		t.Fatalf("encrypted backup is missing magic header %q", backupMagic)
	}
	salt := encrypted[len(backupMagic) : len(backupMagic)+16]
	iv := encrypted[len(backupMagic)+16 : len(backupMagic)+28]
	ciphertext := encrypted[len(backupMagic)+28:]
	key, err := scrypt.Key([]byte("correct horse battery staple"), salt, 16384, 8, 1, 32)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := gcm.Open(nil, iv, ciphertext, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decrypted, plain) {
		t.Fatalf("decrypted backup = %q, want %q", decrypted, plain)
	}
}

func TestGzipFileProducesReadableGzip(t *testing.T) {
	tempDir := t.TempDir()
	sourcePath := filepath.Join(tempDir, "backup.sqlite3")
	targetPath := sourcePath + ".gz"
	plain := []byte("sqlite backup bytes")
	if err := os.WriteFile(sourcePath, plain, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := gzipFile(sourcePath, targetPath); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	buffer := new(bytes.Buffer)
	if _, err := buffer.ReadFrom(reader); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buffer.Bytes(), plain) {
		t.Fatalf("gzip payload = %q, want %q", buffer.Bytes(), plain)
	}
}

func TestBackupRetentionCutoffAvoidsDurationOverflow(t *testing.T) {
	nowUnix := int64(1_789_137_245)
	if got := backupRetentionCutoffUnix(nowUnix, 30); got != 1_786_545_245 {
		t.Fatalf("backupRetentionCutoffUnix normal value = %d", got)
	}
	if got := backupRetentionCutoffUnix(nowUnix, 0); got != 1_789_050_845 {
		t.Fatalf("backupRetentionCutoffUnix clamps non-positive days = %d", got)
	}
	if got := backupRetentionCutoffUnix(nowUnix, 200_000_000_000_000); got != -1<<63 {
		t.Fatalf("backupRetentionCutoffUnix huge value = %d, want MinInt64", got)
	}
}
