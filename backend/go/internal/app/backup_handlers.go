package app

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	settingspkg "github.com/swzyt/chronoframe/backend/go/internal/settings"
	"golang.org/x/crypto/scrypt"
)

var backupMagic = []byte("CFDBENC2")

type databaseBackupSettings struct {
	Enabled              bool
	Cron                 string
	Timezone             string
	RetentionDays        int
	SMTPHost             string
	SMTPPort             int
	SMTPSecure           bool
	SMTPUser             string
	SMTPPassword         string
	MailFrom             string
	MailTo               string
	EncryptionPassphrase string
}

type databaseBackupFile struct {
	FilePath  string
	Encrypted bool
}

func (a *Application) backupRun(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.settings == nil || a.database == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	result, err := a.runDatabaseBackup(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"success": true,
		"result":  result,
	})
}

func (a *Application) runDatabaseBackup(ctx context.Context) (map[string]any, error) {
	backupSettings, err := a.loadDatabaseBackupSettings(ctx)
	if err != nil {
		return nil, err
	}
	if err := assertDatabaseBackupSettings(backupSettings); err != nil {
		return nil, err
	}
	backup, err := a.createDatabaseBackupFile(ctx, backupSettings)
	if err != nil {
		return nil, fmt.Errorf("create database backup file: %w", err)
	}
	sentTo, err := sendDatabaseBackupEmail(ctx, backupSettings, backup)
	if err != nil {
		return nil, fmt.Errorf("send database backup email: %w", err)
	}
	fileStat, err := os.Stat(backup.FilePath)
	if err != nil {
		return nil, fmt.Errorf("stat database backup file: %w", err)
	}
	if err := cleanupOldDatabaseBackups(backupSettings.RetentionDays); err != nil {
		return nil, fmt.Errorf("cleanup old database backups: %w", err)
	}
	return map[string]any{
		"fileName":  filepath.Base(backup.FilePath),
		"filePath":  backup.FilePath,
		"size":      fileStat.Size(),
		"encrypted": backup.Encrypted,
		"sentTo":    sentTo,
		"createdAt": a.now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}, nil
}

func (a *Application) loadDatabaseBackupSettings(ctx context.Context) (databaseBackupSettings, error) {
	smtpPort, err := a.backupIntSetting(ctx, "smtpPort", 465)
	if err != nil {
		return databaseBackupSettings{}, err
	}
	retentionDays, err := a.backupIntSetting(ctx, "retentionDays", 30)
	if err != nil {
		return databaseBackupSettings{}, err
	}
	if retentionDays < 1 {
		retentionDays = 1
	}
	enabled, err := a.backupBoolSetting(ctx, "enabled", false)
	if err != nil {
		return databaseBackupSettings{}, err
	}
	smtpSecure, err := a.backupBoolSetting(ctx, "smtpSecure", true)
	if err != nil {
		return databaseBackupSettings{}, err
	}
	smtpUser, err := a.backupStringSetting(ctx, "smtpUser", "")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	mailFrom, err := a.backupStringSetting(ctx, "mailFrom", "")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	cron, err := a.backupStringSetting(ctx, "cron", "0 3 * * *")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	timezone, err := a.backupStringSetting(ctx, "timezone", "Asia/Shanghai")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	smtpHost, err := a.backupStringSetting(ctx, "smtpHost", "")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	smtpPassword, err := a.backupStringSetting(ctx, "smtpPassword", "")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	mailTo, err := a.backupStringSetting(ctx, "mailTo", "")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	encryptionPassphrase, err := a.backupStringSetting(ctx, "encryptionPassphrase", "")
	if err != nil {
		return databaseBackupSettings{}, err
	}
	return databaseBackupSettings{
		Enabled:              enabled,
		Cron:                 cron,
		Timezone:             timezone,
		RetentionDays:        retentionDays,
		SMTPHost:             smtpHost,
		SMTPPort:             smtpPort,
		SMTPSecure:           smtpSecure,
		SMTPUser:             smtpUser,
		SMTPPassword:         smtpPassword,
		MailFrom:             firstNonEmpty(mailFrom, smtpUser),
		MailTo:               mailTo,
		EncryptionPassphrase: encryptionPassphrase,
	}, nil
}

func (a *Application) backupStringSetting(ctx context.Context, key, fallback string) (string, error) {
	row, err := a.settings.Value(ctx, "system", "backup."+key)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil
	}
	if err != nil {
		return "", err
	}
	value, ok := settingspkg.DecodeValue(row.Type, row.Value).(string)
	if !ok {
		return fallback, nil
	}
	return value, nil
}

func (a *Application) backupBoolSetting(ctx context.Context, key string, fallback bool) (bool, error) {
	row, err := a.settings.Value(ctx, "system", "backup."+key)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil
	}
	if err != nil {
		return false, err
	}
	value, ok := settingspkg.BooleanValue(row.Value)
	if !ok {
		return fallback, nil
	}
	return value, nil
}

func (a *Application) backupIntSetting(ctx context.Context, key string, fallback int) (int, error) {
	row, err := a.settings.Value(ctx, "system", "backup."+key)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil
	}
	if err != nil {
		return 0, err
	}
	value, ok := settingspkg.NumberValue(row.Value)
	if !ok {
		return fallback, nil
	}
	return int(value), nil
}

func assertDatabaseBackupSettings(settings databaseBackupSettings) error {
	if strings.TrimSpace(settings.SMTPHost) == "" {
		return errors.New("SMTP host is required")
	}
	if settings.SMTPPort < 1 || settings.SMTPPort > 65535 {
		return errors.New("SMTP port is invalid")
	}
	if strings.TrimSpace(settings.MailTo) == "" {
		return errors.New("Recipient email is required")
	}
	if len(parseBackupRecipients(settings.MailTo)) == 0 {
		return errors.New("Recipient email is invalid")
	}
	if strings.TrimSpace(settings.MailFrom) == "" && strings.TrimSpace(settings.SMTPUser) == "" {
		return errors.New("Sender email or SMTP username is required")
	}
	if !validCronExpression(settings.Cron) {
		return errors.New("Backup cron expression is invalid")
	}
	return nil
}

func (a *Application) createDatabaseBackupFile(ctx context.Context, settings databaseBackupSettings) (databaseBackupFile, error) {
	backupDir := strings.TrimSpace(os.Getenv("CFRAME_BACKUP_DIR"))
	if backupDir == "" {
		backupDir = "data/backups"
	}
	absoluteDir, err := filepath.Abs(backupDir)
	if err != nil {
		return databaseBackupFile{}, fmt.Errorf("resolve backup directory: %w", err)
	}
	if err := os.MkdirAll(absoluteDir, 0o755); err != nil {
		return databaseBackupFile{}, fmt.Errorf("create backup directory: %w", err)
	}
	timestamp := a.now().UTC().Format("2006-01-02T150405Z")
	rawPath := filepath.Join(absoluteDir, "chronoframe-db-"+timestamp+".sqlite3")
	gzipPath := rawPath + ".gz"
	encryptedPath := gzipPath + ".enc"
	if _, err := a.database.SQL().ExecContext(ctx, "VACUUM INTO ?", rawPath); err != nil {
		return databaseBackupFile{}, fmt.Errorf("write SQLite backup: %w", err)
	}
	if err := gzipFile(rawPath, gzipPath); err != nil {
		return databaseBackupFile{}, fmt.Errorf("gzip SQLite backup: %w", err)
	}
	_ = os.Remove(rawPath)
	if strings.TrimSpace(settings.EncryptionPassphrase) == "" {
		return databaseBackupFile{FilePath: gzipPath, Encrypted: false}, nil
	}
	if err := encryptBackupFile(gzipPath, encryptedPath, settings.EncryptionPassphrase); err != nil {
		return databaseBackupFile{}, fmt.Errorf("encrypt SQLite backup: %w", err)
	}
	_ = os.Remove(gzipPath)
	return databaseBackupFile{FilePath: encryptedPath, Encrypted: true}, nil
}

func gzipFile(sourcePath, targetPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.Create(targetPath)
	if err != nil {
		return err
	}
	defer target.Close()
	writer, err := gzip.NewWriterLevel(target, gzip.BestCompression)
	if err != nil {
		return err
	}
	if _, err := io.Copy(writer, source); err != nil {
		_ = writer.Close()
		return err
	}
	return writer.Close()
}

func encryptBackupFile(sourcePath, targetPath, passphrase string) error {
	plain, err := os.ReadFile(sourcePath)
	if err != nil {
		return err
	}
	salt := make([]byte, 16)
	iv := make([]byte, 12)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	if _, err := rand.Read(iv); err != nil {
		return err
	}
	key, err := scrypt.Key([]byte(passphrase), salt, 16384, 8, 1, 32)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	sealed := gcm.Seal(nil, iv, plain, nil)
	output := make([]byte, 0, len(backupMagic)+len(salt)+len(iv)+len(sealed))
	output = append(output, backupMagic...)
	output = append(output, salt...)
	output = append(output, iv...)
	output = append(output, sealed...)
	return os.WriteFile(targetPath, output, 0o600)
}

func sendDatabaseBackupEmail(ctx context.Context, settings databaseBackupSettings, backup databaseBackupFile) ([]string, error) {
	recipients := parseBackupRecipients(settings.MailTo)
	client, closer, err := dialSMTP(ctx, settings)
	if err != nil {
		return nil, err
	}
	defer closer()
	from := firstNonEmpty(settings.MailFrom, settings.SMTPUser)
	if strings.TrimSpace(settings.SMTPUser) != "" {
		auth := smtp.PlainAuth("", settings.SMTPUser, settings.SMTPPassword, settings.SMTPHost)
		if err := client.Auth(auth); err != nil {
			return nil, err
		}
	}
	if err := client.Mail(smtpEnvelopeAddress(from)); err != nil {
		return nil, err
	}
	for _, recipient := range recipients {
		if err := client.Rcpt(recipient); err != nil {
			return nil, err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return nil, err
	}
	if err := writeBackupMessage(writer, settings, backup, recipients); err != nil {
		_ = writer.Close()
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return recipients, nil
}

func dialSMTP(ctx context.Context, settings databaseBackupSettings) (*smtp.Client, func(), error) {
	dialer := net.Dialer{Timeout: 15 * time.Second}
	address := net.JoinHostPort(settings.SMTPHost, strconv.Itoa(settings.SMTPPort))
	var conn net.Conn
	var err error
	if settings.SMTPSecure {
		conn, err = tls.DialWithDialer(&dialer, "tcp", address, &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: settings.SMTPHost,
		})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return nil, nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	client, err := smtp.NewClient(conn, settings.SMTPHost)
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	closer := func() {
		_ = client.Quit()
		_ = conn.Close()
	}
	if !settings.SMTPSecure {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{MinVersion: tls.VersionTLS12, ServerName: settings.SMTPHost}); err != nil {
				closer()
				return nil, nil, err
			}
		}
	}
	return client, closer, nil
}

func writeBackupMessage(writer io.Writer, settings databaseBackupSettings, backup databaseBackupFile, recipients []string) error {
	boundary := "chronoframe-backup-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	fileName := filepath.Base(backup.FilePath)
	encryptionNote := ""
	if backup.Encrypted {
		encryptionNote = "\r\n\r\nThis attachment is encrypted with AES-256-GCM in ChronoFrame stream format v2. Keep the configured passphrase safe."
	}
	headers := []string{
		"From: " + firstNonEmpty(settings.MailFrom, settings.SMTPUser),
		"To: " + strings.Join(recipients, ", "),
		"Subject: ChronoFrame database backup " + time.Now().UTC().Format(time.RFC3339Nano),
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="` + boundary + `"`,
		"",
		"--" + boundary,
		`Content-Type: text/plain; charset="utf-8"`,
		"Content-Transfer-Encoding: 8bit",
		"",
		"ChronoFrame database backup is attached." + encryptionNote,
		"--" + boundary,
		`Content-Type: application/octet-stream; name="` + fileName + `"`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: attachment; filename="` + fileName + `"`,
		"",
	}
	if _, err := io.WriteString(writer, strings.Join(headers, "\r\n")+"\r\n"); err != nil {
		return err
	}
	file, err := os.Open(backup.FilePath)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := writeBase64Lines(writer, file); err != nil {
		return err
	}
	_, err = io.WriteString(writer, "\r\n--"+boundary+"--\r\n")
	return err
}

func writeBase64Lines(writer io.Writer, reader io.Reader) error {
	buffered := bufio.NewReader(reader)
	raw := make([]byte, 57)
	encoded := make([]byte, 76)
	for {
		n, err := io.ReadFull(buffered, raw)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			base64.StdEncoding.Encode(encoded[:base64.StdEncoding.EncodedLen(n)], raw[:n])
			_, writeErr := writer.Write(encoded[:base64.StdEncoding.EncodedLen(n)])
			if writeErr != nil {
				return writeErr
			}
			_, writeErr = io.WriteString(writer, "\r\n")
			return writeErr
		}
		if err != nil {
			return err
		}
		base64.StdEncoding.Encode(encoded, raw[:n])
		if _, err := writer.Write(encoded); err != nil {
			return err
		}
		if _, err := io.WriteString(writer, "\r\n"); err != nil {
			return err
		}
	}
}

func cleanupOldDatabaseBackups(retentionDays int) error {
	backupDir := strings.TrimSpace(os.Getenv("CFRAME_BACKUP_DIR"))
	if backupDir == "" {
		backupDir = "data/backups"
	}
	absoluteDir, err := filepath.Abs(backupDir)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(absoluteDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	cutoffUnix := backupRetentionCutoffUnix(time.Now().Unix(), retentionDays)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "chronoframe-db-") {
			continue
		}
		path := filepath.Join(absoluteDir, entry.Name())
		info, err := entry.Info()
		if err == nil && info.ModTime().Unix() < cutoffUnix {
			_ = os.Remove(path)
		}
	}
	return nil
}

func backupRetentionCutoffUnix(nowUnix int64, retentionDays int) int64 {
	if retentionDays < 1 {
		retentionDays = 1
	}
	const secondsPerDay int64 = 24 * 60 * 60
	days := int64(retentionDays)
	if days > (1<<63-1)/secondsPerDay {
		return -1 << 63
	}
	return nowUnix - days*secondsPerDay
}

func parseBackupRecipients(value string) []string {
	parts := strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == '\n' || r == ';'
	})
	recipients := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			recipients = append(recipients, trimmed)
		}
	}
	return recipients
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func smtpEnvelopeAddress(value string) string {
	address, err := mail.ParseAddress(value)
	if err == nil && strings.TrimSpace(address.Address) != "" {
		return address.Address
	}
	return value
}
