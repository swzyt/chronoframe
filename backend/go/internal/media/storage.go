package media

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
	"github.com/swzyt/chronoframe/backend/go/internal/storage"
)

var (
	ErrNotFound       = errors.New("storage object not found")
	ErrInvalidKey     = errors.New("invalid storage key")
	ErrUnsupported    = errors.New("storage provider unsupported")
	ErrProviderConfig = errors.New("storage provider is not configured")
)

type ObjectMeta struct {
	Key          string
	Size         int64
	LastModified time.Time
	ContentType  string
	ETag         string
	RawURL       string
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader contextReader) Read(buffer []byte) (int, error) {
	if err := contextErr(reader.ctx); err != nil {
		return 0, err
	}
	n, err := reader.reader.Read(buffer)
	if err != nil {
		return n, err
	}
	if err := contextErr(reader.ctx); err != nil {
		return n, err
	}
	return n, nil
}

type contextReadSeeker struct {
	contextReader
	seeker io.Seeker
}

func (reader contextReadSeeker) Seek(offset int64, whence int) (int64, error) {
	if err := contextErr(reader.ctx); err != nil {
		return 0, err
	}
	position, err := reader.seeker.Seek(offset, whence)
	if err != nil {
		return position, err
	}
	if err := contextErr(reader.ctx); err != nil {
		return position, err
	}
	return position, nil
}

func readAllContext(ctx context.Context, reader io.Reader) ([]byte, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	return io.ReadAll(contextReader{ctx: ctx, reader: reader})
}

func wrapReaderContext(ctx context.Context, reader io.Reader) io.Reader {
	if seeker, ok := reader.(io.Seeker); ok {
		return contextReadSeeker{
			contextReader: contextReader{ctx: ctx, reader: reader},
			seeker:        seeker,
		}
	}
	return contextReader{ctx: ctx, reader: reader}
}

type Provider struct {
	kind   string
	config map[string]any
	s3     *s3.Client
}

// PublicURL follows the same URL rules as the Node storage providers. It is
// used when a backend writes derived media references back to the shared photo
// row (for example Live Photo video URLs).
func (p *Provider) PublicURL(key string) string {
	if p == nil {
		return ""
	}
	normalized, err := normalizeKey(key)
	if err != nil {
		return ""
	}
	switch p.kind {
	case "local":
		base := strings.TrimRight(stringValue(p.config["baseUrl"]), "/")
		if base == "" {
			base = "/storage"
		}
		prefix := strings.Trim(stringValue(p.config["prefix"]), "/")
		if prefix != "" && !strings.HasPrefix(normalized, prefix+"/") && normalized != prefix {
			normalized = prefix + "/" + normalized
		}
		return base + "/" + normalized
	case "openlist":
		base := strings.TrimRight(stringValue(p.config["cdnUrl"]), "/")
		if base == "" {
			base = strings.TrimRight(stringValue(p.config["baseUrl"]), "/") + "/d"
		}
		root := strings.Trim(stringValue(p.config["rootPath"]), "/")
		if root != "" && !strings.HasPrefix(normalized, root+"/") && normalized != root {
			normalized = root + "/" + normalized
		}
		return base + "/" + normalized
	case "s3":
		absolute, err := p.absoluteS3Key(normalized)
		if err != nil {
			return ""
		}
		if cdn := strings.TrimRight(stringValue(p.config["cdnUrl"]), "/"); cdn != "" {
			return cdn + "/" + absolute
		}
		bucket := stringValue(p.config["bucket"])
		region := stringValue(p.config["region"])
		endpoint := strings.TrimRight(stringValue(p.config["endpoint"]), "/")
		if endpoint == "" {
			return "https://" + bucket + ".s3." + region + ".amazonaws.com/" + absolute
		}
		if strings.Contains(endpoint, "amazonaws.com") {
			return "https://" + bucket + ".s3." + region + ".amazonaws.com/" + absolute
		}
		if strings.Contains(endpoint, "aliyuncs.com") || strings.Contains(endpoint, "myqcloud.com") {
			parsed, parseErr := url.Parse(endpoint)
			if parseErr == nil && parsed.Scheme != "" && parsed.Host != "" {
				parsed.Host = bucket + "." + parsed.Host
				parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + absolute
				return parsed.String()
			}
		}
		return endpoint + "/" + bucket + "/" + absolute
	default:
		return ""
	}
}

func NewProvider(
	ctx context.Context,
	settingsService *settings.Service,
	repository *storage.Repository,
) (*Provider, error) {
	if settingsService == nil || repository == nil {
		return nil, ErrProviderConfig
	}
	active, err := settingsService.Value(ctx, "storage", "provider")
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrProviderConfig
		}
		return nil, err
	}
	id, ok := settings.NumberValue(active.Value)
	if !ok || id < 1 {
		return nil, ErrProviderConfig
	}
	provider, err := repository.FindByID(ctx, int64(id))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrProviderConfig
		}
		return nil, err
	}
	config, ok := provider.Config.(map[string]any)
	if !ok {
		config = map[string]any{}
	}
	result := &Provider{kind: provider.Provider, config: config}
	if provider.Provider == "s3" {
		client, clientErr := newS3Client(config)
		if clientErr != nil {
			return nil, clientErr
		}
		result.s3 = client
	}
	return result, nil
}

func (p *Provider) Kind() string {
	if p == nil {
		return ""
	}
	return p.kind
}

func (p *Provider) StoragePrefix() string {
	if p == nil {
		return ""
	}
	return strings.Trim(strings.ReplaceAll(stringValue(p.config["prefix"]), "\\", "/"), "/")
}

func (p *Provider) SignedUploadURL(ctx context.Context, key string, expiresInSeconds int, contentType string) (string, bool, error) {
	if p == nil || p.kind != "s3" {
		return "", false, nil
	}
	endpoint := strings.ToLower(strings.TrimSpace(stringValue(p.config["endpoint"])))
	if strings.Contains(endpoint, "myqcloud.com") {
		return "", false, nil
	}
	if p.s3 == nil {
		return "", true, ErrProviderConfig
	}
	absoluteKey, err := p.absoluteS3Key(key)
	if err != nil {
		return "", true, err
	}
	if expiresInSeconds <= 0 {
		expiresInSeconds = 3600
	}
	presigner := s3.NewPresignClient(p.s3)
	result, err := presigner.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(stringValue(p.config["bucket"])),
		Key:         aws.String(absoluteKey),
		ContentType: aws.String(contentTypeOrDefault(contentType)),
	}, func(options *s3.PresignOptions) {
		options.Expires = time.Duration(expiresInSeconds) * time.Second
	})
	if err != nil {
		return "", true, mapS3Error(err)
	}
	return result.URL, true, nil
}

func (p *Provider) Get(ctx context.Context, key string) ([]byte, ObjectMeta, error) {
	switch p.kind {
	case "local":
		return p.getLocal(ctx, key)
	case "openlist":
		return p.getHTTP(ctx, key)
	case "s3":
		return p.getS3(ctx, key)
	default:
		return nil, ObjectMeta{}, ErrUnsupported
	}
}

func (p *Provider) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) (ObjectMeta, error) {
	switch p.kind {
	case "local":
		return p.putLocal(ctx, key, body, size, contentType)
	case "openlist":
		return p.putOpenList(ctx, key, body, size, contentType)
	case "s3":
		return p.putS3(ctx, key, body, size, contentType)
	default:
		return ObjectMeta{}, ErrUnsupported
	}
}

func (p *Provider) Delete(ctx context.Context, key string) error {
	switch p.kind {
	case "local":
		return p.deleteLocal(key)
	case "openlist":
		return p.deleteOpenList(ctx, key)
	case "s3":
		return p.deleteS3(ctx, key)
	default:
		return ErrUnsupported
	}
}

func (p *Provider) Meta(ctx context.Context, key string) (ObjectMeta, error) {
	switch p.kind {
	case "local":
		return p.metaLocal(ctx, key)
	case "openlist":
		return p.metaOpenList(ctx, key)
	case "s3":
		return p.metaS3(ctx, key)
	default:
		return ObjectMeta{}, ErrUnsupported
	}
}

func (p *Provider) Range(ctx context.Context, key string, start, end int64) ([]byte, ObjectMeta, error) {
	switch p.kind {
	case "local":
		return p.rangeLocal(ctx, key, start, end)
	case "openlist":
		return p.rangeOpenList(ctx, key, start, end)
	case "s3":
		return p.rangeS3(ctx, key, start, end)
	default:
		return nil, ObjectMeta{}, ErrUnsupported
	}
}

func newS3Client(config map[string]any) (*s3.Client, error) {
	accessKey := strings.TrimSpace(stringValue(config["accessKeyId"]))
	secretKey := strings.TrimSpace(stringValue(config["secretAccessKey"]))
	region := strings.TrimSpace(stringValue(config["region"]))
	if accessKey == "" || secretKey == "" || strings.TrimSpace(stringValue(config["bucket"])) == "" {
		return nil, ErrProviderConfig
	}
	if region == "" {
		region = "auto"
	}
	endpoint := strings.TrimRight(strings.TrimSpace(stringValue(config["endpoint"])), "/")
	awsConfig := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(accessKey, secretKey, ""),
	}
	if endpoint != "" {
		awsConfig.EndpointResolverWithOptions = aws.EndpointResolverWithOptionsFunc(
			func(service string, requestedRegion string, _ ...interface{}) (aws.Endpoint, error) {
				signingRegion := requestedRegion
				if signingRegion == "" {
					signingRegion = region
				}
				return aws.Endpoint{
					URL:               endpoint,
					SigningRegion:     signingRegion,
					HostnameImmutable: false,
				}, nil
			},
		)
	}
	return s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		options.UsePathStyle = boolValue(config["forcePathStyle"])
	}), nil
}

func (p *Provider) absoluteS3Key(key string) (string, error) {
	normalized, err := normalizeKey(key)
	if err != nil {
		return "", err
	}
	prefix := strings.Trim(strings.ReplaceAll(stringValue(p.config["prefix"]), "\\", "/"), "/")
	if prefix != "" && normalized != prefix && !strings.HasPrefix(normalized, prefix+"/") {
		return prefix + "/" + normalized, nil
	}
	return normalized, nil
}

func (p *Provider) getS3(ctx context.Context, key string) ([]byte, ObjectMeta, error) {
	if p.s3 == nil {
		return nil, ObjectMeta{}, ErrProviderConfig
	}
	absoluteKey, err := p.absoluteS3Key(key)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	response, err := p.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(stringValue(p.config["bucket"])),
		Key:    aws.String(absoluteKey),
	})
	if err != nil {
		return nil, ObjectMeta{}, mapS3Error(err)
	}
	defer response.Body.Close()
	data, err := readAllContext(ctx, response.Body)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	return data, s3ObjectMeta(absoluteKey, response.ContentLength, response.ContentType,
		response.ETag, response.LastModified), nil
}

func (p *Provider) putS3(
	ctx context.Context,
	key string,
	body io.Reader,
	size int64,
	contentType string,
) (ObjectMeta, error) {
	if p.s3 == nil {
		return ObjectMeta{}, ErrProviderConfig
	}
	absoluteKey, err := p.absoluteS3Key(key)
	if err != nil {
		return ObjectMeta{}, err
	}
	input := &s3.PutObjectInput{
		Bucket:      aws.String(stringValue(p.config["bucket"])),
		Key:         aws.String(absoluteKey),
		Body:        wrapReaderContext(ctx, body),
		ContentType: aws.String(contentTypeOrDefault(contentType)),
	}
	if size >= 0 {
		input.ContentLength = aws.Int64(size)
	}
	response, err := p.s3.PutObject(ctx, input)
	if err != nil {
		return ObjectMeta{}, mapS3Error(err)
	}
	return ObjectMeta{
		Key: absoluteKey, Size: size, LastModified: time.Now(),
		ContentType: contentTypeOrDefault(contentType), ETag: stringValue(response.ETag),
	}, nil
}

func (p *Provider) deleteS3(ctx context.Context, key string) error {
	if p.s3 == nil {
		return ErrProviderConfig
	}
	absoluteKey, err := p.absoluteS3Key(key)
	if err != nil {
		return err
	}
	_, err = p.s3.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(stringValue(p.config["bucket"])),
		Key:    aws.String(absoluteKey),
	})
	return mapS3Error(err)
}

func (p *Provider) metaS3(ctx context.Context, key string) (ObjectMeta, error) {
	if p.s3 == nil {
		return ObjectMeta{}, ErrProviderConfig
	}
	absoluteKey, err := p.absoluteS3Key(key)
	if err != nil {
		return ObjectMeta{}, err
	}
	response, err := p.s3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(stringValue(p.config["bucket"])),
		Key:    aws.String(absoluteKey),
	})
	if err != nil {
		return ObjectMeta{}, mapS3Error(err)
	}
	return s3ObjectMeta(absoluteKey, response.ContentLength, response.ContentType,
		response.ETag, response.LastModified), nil
}

func (p *Provider) rangeS3(
	ctx context.Context,
	key string,
	start int64,
	end int64,
) ([]byte, ObjectMeta, error) {
	if p.s3 == nil || start < 0 || end < start {
		return nil, ObjectMeta{}, ErrInvalidKey
	}
	absoluteKey, err := p.absoluteS3Key(key)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	response, err := p.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(stringValue(p.config["bucket"])),
		Key:    aws.String(absoluteKey),
		Range:  aws.String(fmt.Sprintf("bytes=%d-%d", start, end)),
	})
	if err != nil {
		return nil, ObjectMeta{}, mapS3Error(err)
	}
	defer response.Body.Close()
	data, err := readAllContext(ctx, response.Body)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	if strings.TrimSpace(stringValue(response.ContentRange)) == "" && int64(len(data)) != end-start+1 {
		data, err = sliceIgnoredHTTPRange(data, start, end)
		if err != nil {
			return nil, ObjectMeta{}, err
		}
	}
	meta := s3ObjectMeta(absoluteKey, response.ContentLength, response.ContentType,
		response.ETag, response.LastModified)
	meta.Size = int64(len(data))
	return data, meta, nil
}

func s3ObjectMeta(
	key string,
	size *int64,
	contentType *string,
	etag *string,
	lastModified *time.Time,
) ObjectMeta {
	meta := ObjectMeta{
		Key: key, ContentType: contentTypeOrDefault(stringValue(contentType)),
		ETag: stringValue(etag),
	}
	if size != nil {
		meta.Size = *size
	}
	if lastModified != nil {
		meta.LastModified = *lastModified
	} else {
		meta.LastModified = time.Now()
	}
	return meta
}

func mapS3Error(err error) error {
	if err == nil {
		return nil
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "status code: 404") ||
		strings.Contains(message, "nosuchkey") ||
		strings.Contains(message, "not found") {
		return ErrNotFound
	}
	return err
}

func contentTypeOrDefault(value string) string {
	if strings.TrimSpace(value) == "" {
		return "application/octet-stream"
	}
	return value
}

func boolValue(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func (p *Provider) resolveLocal(key string) string {
	normalized, err := normalizeKey(key)
	if err != nil {
		return ""
	}
	prefix := stringValue(p.config["prefix"])
	prefix = strings.Trim(strings.ReplaceAll(prefix, "\\", "/"), "/")
	if prefix != "" && normalized != prefix && !strings.HasPrefix(normalized, prefix+"/") {
		normalized = prefix + "/" + normalized
	}
	base := stringValue(p.config["basePath"])
	if base == "" {
		base = "./data/storage"
	}
	if !filepath.IsAbs(base) {
		absolute, _ := filepath.Abs(base)
		base = absolute
	}
	target := filepath.Join(base, filepath.FromSlash(normalized))
	if !lexicallyWithin(base, target) {
		return ""
	}
	return target
}

func lexicallyWithin(base, target string) bool {
	relative, err := filepath.Rel(base, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	return relative != "." || filepath.Clean(base) == filepath.Clean(target)
}

func (p *Provider) safeLocalPath(path string) bool {
	if path == "" {
		return false
	}
	base := stringValue(p.config["basePath"])
	if base == "" {
		base = "./data/storage"
	}
	if !filepath.IsAbs(base) {
		base, _ = filepath.Abs(base)
	}
	base, _ = filepath.Abs(base)
	if !lexicallyWithin(base, path) {
		return false
	}

	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		// A new local provider may not have created its root yet. The caller
		// will create it before writing and validate again.
		return true
	}
	candidate := path
	if _, statErr := os.Lstat(candidate); statErr != nil {
		candidate = filepath.Dir(candidate)
	}
	realCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return false
	}
	return lexicallyWithin(realBase, realCandidate)
}

func (p *Provider) getLocal(ctx context.Context, key string) ([]byte, ObjectMeta, error) {
	if err := contextErr(ctx); err != nil {
		return nil, ObjectMeta{}, err
	}
	normalized, err := normalizeKey(key)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	path := p.resolveLocal(normalized)
	if path == "" {
		return nil, ObjectMeta{}, ErrInvalidKey
	}
	if !p.safeLocalPath(path) {
		return nil, ObjectMeta{}, ErrInvalidKey
	}
	meta, err := p.metaLocal(ctx, normalized)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ObjectMeta{}, ErrNotFound
		}
		return nil, ObjectMeta{}, err
	}
	defer file.Close()
	data, err := readAllContext(ctx, file)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	return data, meta, nil
}

func (p *Provider) rangeLocal(ctx context.Context, key string, start, end int64) ([]byte, ObjectMeta, error) {
	if start < 0 || end < start {
		return nil, ObjectMeta{}, ErrInvalidKey
	}
	if err := contextErr(ctx); err != nil {
		return nil, ObjectMeta{}, err
	}
	normalized, err := normalizeKey(key)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	path := p.resolveLocal(normalized)
	if path == "" {
		return nil, ObjectMeta{}, ErrInvalidKey
	}
	if !p.safeLocalPath(path) {
		return nil, ObjectMeta{}, ErrInvalidKey
	}
	meta, err := p.metaLocal(ctx, normalized)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ObjectMeta{}, ErrNotFound
		}
		return nil, ObjectMeta{}, err
	}
	defer file.Close()
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, ObjectMeta{}, err
	}
	data, err := readAllContext(ctx, io.LimitReader(file, end-start+1))
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	return data, meta, nil
}

func (p *Provider) metaLocal(ctx context.Context, key string) (ObjectMeta, error) {
	if err := contextErr(ctx); err != nil {
		return ObjectMeta{}, err
	}
	normalized, err := normalizeKey(key)
	if err != nil {
		return ObjectMeta{}, err
	}
	path := p.resolveLocal(normalized)
	if path == "" {
		return ObjectMeta{}, ErrInvalidKey
	}
	if !p.safeLocalPath(path) {
		return ObjectMeta{}, ErrInvalidKey
	}
	if err := contextErr(ctx); err != nil {
		return ObjectMeta{}, err
	}
	stat, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ObjectMeta{}, ErrNotFound
		}
		return ObjectMeta{}, err
	}
	if !stat.Mode().IsRegular() {
		return ObjectMeta{}, ErrNotFound
	}
	return ObjectMeta{
		Key: normalized, Size: stat.Size(), LastModified: stat.ModTime(),
		ContentType: contentTypeForKey(normalized),
		ETag:        fmt.Sprintf(`W/"%d-%d"`, stat.Size(), stat.ModTime().UnixNano()),
	}, nil
}

func (p *Provider) putLocal(ctx context.Context, key string, body io.Reader, size int64, contentType string) (ObjectMeta, error) {
	if err := contextErr(ctx); err != nil {
		return ObjectMeta{}, err
	}
	normalized, err := normalizeKey(key)
	if err != nil {
		return ObjectMeta{}, err
	}
	path := p.resolveLocal(normalized)
	if path == "" {
		return ObjectMeta{}, ErrInvalidKey
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return ObjectMeta{}, err
	}
	if !p.safeLocalPath(path) {
		return ObjectMeta{}, ErrInvalidKey
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".chronoframe-upload-*")
	if err != nil {
		return ObjectMeta{}, err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	source := wrapReaderContext(ctx, body)
	if size >= 0 {
		_, err = io.CopyN(temp, source, size)
	} else {
		_, err = io.Copy(temp, source)
	}
	if err == nil {
		err = temp.Close()
	} else {
		_ = temp.Close()
	}
	if err != nil {
		return ObjectMeta{}, err
	}
	if err := contextErr(ctx); err != nil {
		return ObjectMeta{}, err
	}
	if err := os.Rename(tempName, path); err != nil {
		return ObjectMeta{}, err
	}
	return p.metaLocal(ctx, normalized)
}

func (p *Provider) deleteLocal(key string) error {
	normalized, err := normalizeKey(key)
	if err != nil {
		return err
	}
	path := p.resolveLocal(normalized)
	if !p.safeLocalPath(path) {
		return ErrInvalidKey
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func normalizeKey(key string) (string, error) {
	value, err := url.PathUnescape(strings.TrimSpace(key))
	if err != nil {
		return "", ErrInvalidKey
	}
	if strings.Contains(value, "\\") {
		return "", ErrInvalidKey
	}
	value = strings.Trim(value, "/")
	if value == "" || strings.Contains(value, "..") {
		return "", ErrInvalidKey
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return "", ErrInvalidKey
		}
	}
	return value, nil
}

func contentTypeForKey(key string) string {
	switch strings.ToLower(filepath.Ext(key)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".avif":
		return "image/avif"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	default:
		return "application/octet-stream"
	}
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case *string:
		if typed == nil {
			return ""
		}
		return *typed
	case json.Number:
		return typed.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(value)
	}
}

func (p *Provider) getHTTP(ctx context.Context, key string) ([]byte, ObjectMeta, error) {
	baseURL := strings.TrimRight(stringValue(p.config["baseUrl"]), "/")
	download := stringValue(p.config["downloadEndpoint"])
	cdnURL := strings.TrimRight(stringValue(p.config["cdnUrl"]), "/")
	if baseURL == "" && cdnURL == "" {
		return nil, ObjectMeta{}, ErrProviderConfig
	}
	field := stringValue(p.config["pathField"])
	if field == "" {
		field = "path"
	}
	root := strings.Trim(stringValue(p.config["rootPath"]), "/")
	normalized, err := normalizeKey(key)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	if root != "" && normalized != root && !strings.HasPrefix(normalized, root+"/") {
		normalized = root + "/" + normalized
	}
	var target *url.URL
	if download != "" {
		parsed, parseErr := url.Parse(baseURL + download)
		if parseErr != nil {
			return nil, ObjectMeta{}, parseErr
		}
		query := parsed.Query()
		query.Set(field, normalized)
		parsed.RawQuery = query.Encode()
		target = parsed
	} else {
		if cdnURL == "" {
			meta, metaErr := p.metaOpenList(ctx, normalized)
			if metaErr != nil || strings.TrimSpace(meta.RawURL) == "" {
				return nil, ObjectMeta{}, ErrProviderConfig
			}
			parsed, parseErr := url.Parse(meta.RawURL)
			if parseErr != nil {
				return nil, ObjectMeta{}, parseErr
			}
			target = parsed
		} else {
			// OpenList deployments commonly expose a CDN/raw download URL instead
			// of a JSON download endpoint. Keep the same rooted key contract.
			escapedParts := make([]string, 0, len(strings.Split(normalized, "/")))
			for _, part := range strings.Split(normalized, "/") {
				escapedParts = append(escapedParts, url.PathEscape(part))
			}
			parsed, parseErr := url.Parse(cdnURL + "/" + strings.Join(escapedParts, "/"))
			if parseErr != nil {
				return nil, ObjectMeta{}, parseErr
			}
			target = parsed
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	if token := stringValue(p.config["token"]); token != "" {
		req.Header.Set("Authorization", token)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, ObjectMeta{}, ErrNotFound
	}
	data, err := readAllContext(ctx, response.Body)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	return data, ObjectMeta{
		Key: normalized, Size: int64(len(data)),
		ContentType:  contentTypeOrDefault(response.Header.Get("Content-Type")),
		ETag:         response.Header.Get("ETag"),
		LastModified: time.Now(),
	}, nil
}

func (p *Provider) putOpenList(ctx context.Context, key string, body io.Reader, size int64, contentType string) (ObjectMeta, error) {
	baseURL := strings.TrimRight(stringValue(p.config["baseUrl"]), "/")
	if baseURL == "" {
		return ObjectMeta{}, ErrProviderConfig
	}
	normalized, err := p.openListKey(key)
	if err != nil {
		return ObjectMeta{}, err
	}
	endpoint := stringValue(p.config["uploadEndpoint"])
	if endpoint == "" {
		endpoint = "/api/fs/put"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut,
		baseURL+endpoint, wrapReaderContext(ctx, body))
	if err != nil {
		return ObjectMeta{}, err
	}
	request.Header.Set("Content-Type", contentTypeOrDefault(contentType))
	request.Header.Set("File-Path", url.PathEscape("/"+normalized))
	if size >= 0 {
		request.ContentLength = size
	}
	if token := strings.TrimSpace(stringValue(p.config["token"])); token != "" {
		request.Header.Set("Authorization", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ObjectMeta{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return ObjectMeta{}, fmt.Errorf("openlist upload failed: %s", response.Status)
	}
	if meta, err := p.metaOpenList(ctx, normalized); err == nil {
		return meta, nil
	}
	return ObjectMeta{
		Key: normalized, Size: size, ContentType: contentTypeOrDefault(contentType),
		LastModified: time.Now(),
	}, nil
}

func (p *Provider) deleteOpenList(ctx context.Context, key string) error {
	baseURL := strings.TrimRight(stringValue(p.config["baseUrl"]), "/")
	if baseURL == "" {
		return ErrProviderConfig
	}
	normalized, err := p.openListKey(key)
	if err != nil {
		return err
	}
	endpoint := stringValue(p.config["deleteEndpoint"])
	if endpoint == "" {
		endpoint = "/api/fs/remove"
	}
	trimmed := strings.Trim(normalized, "/")
	dir := "/"
	name := trimmed
	if index := strings.LastIndex(trimmed, "/"); index >= 0 {
		dir = "/" + trimmed[:index]
		name = trimmed[index+1:]
	}
	payload, err := json.Marshal(map[string]any{"dir": dir, "names": []string{name}})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		baseURL+endpoint, strings.NewReader(string(payload)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(stringValue(p.config["token"])); token != "" {
		request.Header.Set("Authorization", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("openlist delete failed: %s", response.Status)
	}
	return nil
}

func (p *Provider) openListKey(key string) (string, error) {
	normalized, err := normalizeKey(key)
	if err != nil {
		return "", err
	}
	root := strings.Trim(strings.ReplaceAll(stringValue(p.config["rootPath"]), "\\", "/"), "/")
	if root != "" && normalized != root && !strings.HasPrefix(normalized, root+"/") {
		normalized = root + "/" + normalized
	}
	return normalized, nil
}

func (p *Provider) metaOpenList(ctx context.Context, key string) (ObjectMeta, error) {
	baseURL := strings.TrimRight(stringValue(p.config["baseUrl"]), "/")
	if baseURL == "" {
		return ObjectMeta{}, ErrProviderConfig
	}
	normalized, err := p.openListKey(key)
	if err != nil {
		return ObjectMeta{}, err
	}
	endpoint := stringValue(p.config["metaEndpoint"])
	if endpoint == "" {
		endpoint = "/api/fs/get"
	}
	field := stringValue(p.config["pathField"])
	if field == "" {
		field = "path"
	}
	payload := map[string]any{
		field: "/" + normalized, "password": "", "page": 1, "per_page": 0, "refresh": false,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return ObjectMeta{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		baseURL+endpoint, strings.NewReader(string(body)))
	if err != nil {
		return ObjectMeta{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	if token := strings.TrimSpace(stringValue(p.config["token"])); token != "" {
		request.Header.Set("Authorization", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return ObjectMeta{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusNotFound {
			return ObjectMeta{}, ErrNotFound
		}
		return ObjectMeta{}, fmt.Errorf("openlist metadata failed: %s", response.Status)
	}
	var decoded struct {
		Data struct {
			Size         any    `json:"size"`
			Modified     string `json:"modified"`
			LastModified string `json:"lastModified"`
			ETag         string `json:"etag"`
			RawURL       string `json:"raw_url"`
			ContentType  string `json:"content_type"`
		} `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return ObjectMeta{Key: normalized, ContentType: contentTypeForKey(normalized)}, nil
	}
	meta := ObjectMeta{
		Key: normalized, ETag: decoded.Data.ETag,
		ContentType:  contentTypeOrDefault(decoded.Data.ContentType),
		LastModified: time.Now(),
		RawURL:       decoded.Data.RawURL,
	}
	if decoded.Data.Modified != "" {
		if parsed, parseErr := time.Parse(time.RFC3339, decoded.Data.Modified); parseErr == nil {
			meta.LastModified = parsed
		}
	} else if decoded.Data.LastModified != "" {
		if parsed, parseErr := time.Parse(time.RFC3339, decoded.Data.LastModified); parseErr == nil {
			meta.LastModified = parsed
		}
	}
	switch size := decoded.Data.Size.(type) {
	case float64:
		meta.Size = int64(size)
	case json.Number:
		meta.Size, _ = size.Int64()
	}
	return meta, nil
}

func (p *Provider) rangeOpenList(
	ctx context.Context,
	key string,
	start int64,
	end int64,
) ([]byte, ObjectMeta, error) {
	if start < 0 || end < start {
		return nil, ObjectMeta{}, ErrInvalidKey
	}
	baseURL := strings.TrimRight(stringValue(p.config["baseUrl"]), "/")
	if baseURL == "" {
		return nil, ObjectMeta{}, ErrProviderConfig
	}
	download := stringValue(p.config["downloadEndpoint"])
	cdnURL := strings.TrimRight(stringValue(p.config["cdnUrl"]), "/")
	normalized, err := p.openListKey(key)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	var target string
	if download != "" {
		parsed, parseErr := url.Parse(baseURL + download)
		if parseErr != nil {
			return nil, ObjectMeta{}, parseErr
		}
		query := parsed.Query()
		field := stringValue(p.config["pathField"])
		if field == "" {
			field = "path"
		}
		query.Set(field, normalized)
		parsed.RawQuery = query.Encode()
		target = parsed.String()
	} else {
		if cdnURL == "" {
			meta, metaErr := p.metaOpenList(ctx, normalized)
			if metaErr != nil || strings.TrimSpace(meta.RawURL) == "" {
				return nil, ObjectMeta{}, ErrProviderConfig
			}
			target = meta.RawURL
		} else {
			parts := make([]string, 0, len(strings.Split(normalized, "/")))
			for _, item := range strings.Split(normalized, "/") {
				parts = append(parts, url.PathEscape(item))
			}
			target = cdnURL + "/" + strings.Join(parts, "/")
		}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	request.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	if token := strings.TrimSpace(stringValue(p.config["token"])); token != "" {
		request.Header.Set("Authorization", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, ObjectMeta{}, ErrNotFound
	}
	data, err := readAllContext(ctx, response.Body)
	if err != nil {
		return nil, ObjectMeta{}, err
	}
	if response.StatusCode == http.StatusOK {
		data, err = sliceIgnoredHTTPRange(data, start, end)
		if err != nil {
			return nil, ObjectMeta{}, err
		}
	}
	meta, _ := p.metaOpenList(ctx, normalized)
	meta.Key = normalized
	meta.Size = int64(len(data))
	return data, meta, nil
}

func sliceIgnoredHTTPRange(data []byte, start, end int64) ([]byte, error) {
	if start < 0 || end < start || end >= int64(len(data)) {
		return nil, ErrInvalidKey
	}
	return data[start : end+1], nil
}

func (p *Provider) String() string {
	return strconv.Quote(p.kind)
}
