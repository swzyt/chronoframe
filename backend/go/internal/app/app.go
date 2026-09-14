package app

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/access"
	"github.com/swzyt/chronoframe/backend/go/internal/albums"
	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/photos"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/config"
	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
	"github.com/swzyt/chronoframe/backend/go/internal/queue"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
	"github.com/swzyt/chronoframe/backend/go/internal/storage"
	"github.com/swzyt/chronoframe/backend/go/internal/uploads"
)

const invalidAlbumIDMessage = `[
  {
    "origin": "string",
    "code": "invalid_format",
    "format": "regex",
    "pattern": "/^\\d+$/",
    "path": [
      "albumId"
    ],
    "message": "Invalid string: must match pattern /^\\d+$/"
  }
]`

type zodErrorData struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

type RedisHealth interface {
	Ping(context.Context) error
	GetString(context.Context, string) (string, error)
}

type MediaToolChecker interface {
	Check(context.Context) map[string]string
}

type Dependencies struct {
	Config     config.Config
	Logger     *slog.Logger
	Database   *platformdb.Store
	Redis      RedisHealth
	MediaTools MediaToolChecker
	Settings   *settings.Service
	Albums     *albums.Repository
	Photos     *photos.Repository
	Auth       *auth.Service
	Access     *access.Service
	Queue      *queue.Repository
	Storage    *storage.Repository
	Uploads    *uploads.Repository
	Now        func() time.Time
}

type Application struct {
	config           config.Config
	logger           *slog.Logger
	database         *platformdb.Store
	redis            RedisHealth
	settings         *settings.Service
	albums           *albums.Repository
	photos           *photos.Repository
	auth             *auth.Service
	access           *access.Service
	queue            *queue.Repository
	storage          *storage.Repository
	uploads          *uploads.Repository
	mediaTools       MediaToolChecker
	consumerMu       sync.RWMutex
	pipelineConsumer *PipelineConsumer
	now              func() time.Time
	startedAt        time.Time
}

func NewApplication(dependencies Dependencies) *Application {
	application := &Application{
		config: dependencies.Config, logger: dependencies.Logger, database: dependencies.Database,
		redis: dependencies.Redis, mediaTools: dependencies.MediaTools,
		settings: dependencies.Settings, albums: dependencies.Albums,
		photos: dependencies.Photos, auth: dependencies.Auth, access: dependencies.Access,
		queue: dependencies.Queue, storage: dependencies.Storage, uploads: dependencies.Uploads,
		now:       dependencies.Now,
		startedAt: time.Now(),
	}
	if application.now == nil {
		application.now = time.Now
	}
	if application.mediaTools == nil {
		application.mediaTools = defaultMediaToolChecker{}
	}
	return application
}

func New(dependencies Dependencies) http.Handler {
	return NewApplication(dependencies).Handler()
}

func (a *Application) SetPipelineConsumer(consumer *PipelineConsumer) {
	a.consumerMu.Lock()
	defer a.consumerMu.Unlock()
	a.pipelineConsumer = consumer
}

func (a *Application) PipelineConsumer() *PipelineConsumer {
	a.consumerMu.RLock()
	defer a.consumerMu.RUnlock()
	return a.pipelineConsumer
}

func (application *Application) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health/live", application.method(http.MethodGet, application.live))
	mux.HandleFunc("/health/ready", application.method(http.MethodGet, application.ready))
	mux.HandleFunc("/version", application.method(http.MethodGet, application.version))
	mux.HandleFunc("/api/system/settings/all", application.method(http.MethodGet, application.publicSettings))
	mux.HandleFunc("/api/access/config", application.accessConfigRoute)
	mux.HandleFunc("/api/admin/users", application.adminUsersRoute)
	mux.HandleFunc("/api/admin/users/{id}", application.adminUserRoute)
	mux.HandleFunc("/api/albums", application.albumsRoute)
	mux.HandleFunc("/api/albums/{albumID}", application.albumRoute)
	mux.HandleFunc("/api/albums/{albumID}/photos/{photoID}", writeJSONMethod(http.MethodDelete, application.albumPhotoDelete))
	mux.HandleFunc("/api/access/status", application.method(http.MethodGet, application.accessStatus))
	mux.HandleFunc("/api/photos/visible", application.method(http.MethodGet, application.publicPhotos))
	mux.HandleFunc("/api/photos/map", application.method(http.MethodGet, application.photoMap))
	mux.HandleFunc("/api/photos/status", application.method(http.MethodGet, application.photoStatus))
	mux.HandleFunc("/api/photos/{photoID}", application.photoRoute)
	mux.HandleFunc("/api/photos/{photoID}/albums", application.photoAlbumsRoute)
	mux.HandleFunc("/api/photos/{photoID}/livephoto", application.method(http.MethodGet, application.photoLivePhoto))
	mux.HandleFunc("/api/photos/{photoID}/reactions", application.photoReactionsRoute)
	mux.HandleFunc("/api/photos/reactions", application.method(http.MethodGet, application.photoReactionCounts))
	mux.HandleFunc("/api/photos/albums", writeJSONMethod(http.MethodPut, application.photoAlbumsBulkUpdate))
	mux.HandleFunc("/api/photos", application.photosRoute)
	mux.HandleFunc("/api/photos/upload", writeJSONMethod(http.MethodPut, application.photoUpload))
	mux.HandleFunc("/api/photos/check-duplicate", writeJSONMethod(http.MethodPost, application.photoDuplicateCheck))
	mux.HandleFunc("/api/photos/exif/reindex", writeJSONMethod(http.MethodPost, application.photoExifReindex))
	mux.HandleFunc("/api/photos/livephoto/manage", writeJSONMethod(http.MethodPost, application.livePhotoManage))
	mux.HandleFunc("/api/profile", application.method(http.MethodGet, application.profile))
	mux.HandleFunc("/api/login", writeJSONMethod(http.MethodPost, application.login))
	mux.HandleFunc("/api/logout", application.method(http.MethodGet, application.logout))
	mux.HandleFunc("/api/_auth/session", application.authSessionRoute)
	mux.HandleFunc("/api/access/verify", writeJSONMethod(http.MethodPost, application.accessVerify))
	mux.HandleFunc("/api/queue/stats", application.method(http.MethodGet, application.queueStats))
	mux.HandleFunc("/api/queue/stats/{taskID}", application.method(http.MethodGet, application.queueTaskStats))
	mux.HandleFunc("/api/queue/task/list", application.method(http.MethodGet, application.queueTaskList))
	mux.HandleFunc("/api/system/settings/{namespace}", application.method(http.MethodGet, application.settingsNamespace))
	mux.HandleFunc("/api/system/settings/{namespace}/{key}", application.settingsKeyRoute)
	mux.HandleFunc("/api/system/settings/batch", writeJSONMethod(http.MethodPut, application.settingsBatchUpdate))
	mux.HandleFunc("/api/system/settings/fields", application.method(http.MethodGet, application.settingsFields))
	mux.HandleFunc("/api/system/settings/schema", application.method(http.MethodGet, application.settingsSchema))
	mux.HandleFunc("/api/system/settings/storage-config", application.storageConfigRoute)
	mux.HandleFunc("/api/system/settings/storage-config/{id}", application.storageConfigIDRoute)
	mux.HandleFunc("/api/upload-shares", application.uploadSharesRoute)
	mux.HandleFunc("/api/upload-shares/{id}", application.uploadShareIDRoute)
	mux.HandleFunc("/api/upload-shares/public/{token}", application.method(http.MethodGet, application.publicUploadShare))
	mux.HandleFunc("/api/upload-shares/public/{token}/prepare", writeJSONMethod(http.MethodPost, application.publicUploadPrepare))
	mux.HandleFunc("/api/upload-shares/public/{token}/task", writeJSONMethod(http.MethodPost, application.publicUploadTask))
	mux.HandleFunc("/api/upload-shares/public/{token}/upload", writeJSONMethod(http.MethodPut, application.publicUploadObject))
	mux.HandleFunc("/api/queue/add-task", writeJSONMethod(http.MethodPost, application.queueAddTask))
	mux.HandleFunc("/api/queue/add-tasks", writeJSONMethod(http.MethodPost, application.queueAddTasks))
	mux.HandleFunc("/api/queue/task/retry", writeJSONMethod(http.MethodPost, application.queueRetry))
	mux.HandleFunc("/api/queue/task/retry-batch", writeJSONMethod(http.MethodPost, application.queueRetryBatch))
	mux.HandleFunc("/api/queue/task/clear", writeJSONMethod(http.MethodDelete, application.queueClear))
	mux.HandleFunc("/api/system/stats", application.method(http.MethodGet, application.systemStats))
	mux.HandleFunc("/api/system/logs", application.method(http.MethodGet, application.systemLogs))
	mux.HandleFunc("/api/wizard/schema", application.method(http.MethodGet, application.wizardSchema))
	mux.HandleFunc("/api/wizard/admin", writeJSONMethod(http.MethodPost, application.wizardAdmin))
	mux.HandleFunc("/api/wizard/complete", writeJSONMethod(http.MethodPost, application.wizardComplete))
	mux.HandleFunc("/api/wizard/map", writeJSONMethod(http.MethodPost, application.wizardMap))
	mux.HandleFunc("/api/wizard/site", writeJSONMethod(http.MethodPost, application.wizardSite))
	mux.HandleFunc("/api/wizard/storage", writeJSONMethod(http.MethodPost, application.wizardStorage))
	mux.HandleFunc("/api/wizard/submit", writeJSONMethod(http.MethodPost, application.wizardSubmit))
	mux.HandleFunc("/api/system/backup/run", writeJSONMethod(http.MethodPost, application.backupRun))
	mux.HandleFunc("/api/auth/github", application.method(http.MethodGet, application.githubOAuth))
	mux.HandleFunc("/image/{key...}", application.readObjectMethod(application.imageRoute))
	mux.HandleFunc("/storage/{key...}", application.readObjectMethod(application.storageRoute))
	mux.HandleFunc("/display/{photoID}", application.method(http.MethodGet, application.displayRoute))
	mux.HandleFunc("/thumb/{thumbnailURL...}", application.method(http.MethodGet, application.thumbRoute))
	mux.HandleFunc("/og-media/{photoID}", application.method(http.MethodGet, application.ogMediaRoute))
	mux.HandleFunc("/share-og/{photoID}", application.method(http.MethodGet, application.shareOGRoute))
	mux.HandleFunc("/", application.notFound)

	return httpx.Middleware(application.logger, httpx.Metadata{
		BackendVersion: application.config.BackendVersion,
		Maturity:       application.config.Maturity,
		Mode:           application.config.Mode,
	}, mux)
}

func (a *Application) publicAlbums(w http.ResponseWriter, r *http.Request) {
	if a.albums == nil || a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if nodeQueryString(r.URL.Query(), "scope") == "manage" {
		a.managedAlbums(w, r)
		return
	}

	user := a.optionalUser(w, r)
	state := a.accessState(w, r, user != nil)
	limit := int64(0)
	if !state.Granted {
		limit = a.settingInt(r.Context(), "app", "access.previewAlbumLimit", 1)
	}
	data, err := a.albums.ListPublic(r.Context(), limit)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "public albums failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	accessVersion := ""
	if !state.Granted {
		accessVersion = strconv.FormatInt(state.Version, 10)
	}
	response := make([]map[string]any, 0, len(data))
	for _, album := range data {
		value := map[string]any{
			"id":           album.ID,
			"title":        album.Title,
			"description":  album.Description,
			"coverPhotoId": album.CoverPhotoID,
			"isHidden":     album.IsHidden,
			"createdAt":    album.CreatedAt,
			"updatedAt":    album.UpdatedAt,
			"ownerUserId":  album.OwnerUserID,
			"owner":        album.Owner,
			"photoIds":     album.PhotoIDs,
		}
		if !state.Granted {
			previewIDs := uniquePhotoIDs(album.CoverPhotoID, album.PhotoIDs, 3)
			records, err := a.photos.ListByIDs(r.Context(), previewIDs)
			if err != nil {
				a.logger.ErrorContext(r.Context(), "album preview photos failed", "request_id", httpx.RequestID(r.Context()), "error", err)
				httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
				return
			}
			previewPhotos, err := a.publicPhotoResponses(r, records, accessVersion)
			if err != nil {
				a.logger.ErrorContext(r.Context(), "album preview response failed", "request_id", httpx.RequestID(r.Context()), "error", err)
				httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
				return
			}
			value["previewPhotos"] = previewPhotos
		}
		response = append(response, value)
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) publicPhotos(w http.ResponseWriter, r *http.Request) {
	if a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if nodeQueryString(r.URL.Query(), "scope") == "manage" {
		a.managedPhotos(w, r)
		return
	}
	user := a.optionalUser(w, r)
	state := a.accessState(w, r, user != nil)
	limit := int64(0)
	if !state.Granted {
		// Node's getPublicPhotos normalizes every explicit limit to at most 500.
		// Keep that safety bound even when an older database contains a larger
		// preview setting.
		limit = minInt64(a.settingInt(r.Context(), "app", "access.previewPhotoLimit", 10), 500)
	}
	records, err := a.photos.ListPublic(r.Context(), limit)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "public photos failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	response, err := a.publicPhotoResponses(r, records, strconv.FormatInt(state.Version, 10))
	if err != nil {
		a.logger.ErrorContext(r.Context(), "public photo response failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) albumDetail(w http.ResponseWriter, r *http.Request) {
	if a.albums == nil || a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	id, ok := parseAlbumIDPath(w, r.PathValue("albumID"))
	if !ok {
		return
	}
	album, err := a.albums.FindByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "Album not found")
			return
		}
		a.logger.ErrorContext(r.Context(), "album lookup failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	user := a.optionalUser(w, r)
	state := a.accessState(w, r, user != nil)
	if album.IsHidden {
		if user == nil || (user.IsAdmin == 0 && album.OwnerUserID != user.ID) {
			httpx.Error(w, http.StatusNotFound, "Album not found")
			return
		}
	} else if !state.Granted {
		limit := a.settingInt(r.Context(), "app", "access.previewAlbumLimit", 1)
		allowed, err := a.albums.IsPublicWithinLimit(r.Context(), id, limit)
		if err != nil {
			a.logger.ErrorContext(r.Context(), "album access check failed", "request_id", httpx.RequestID(r.Context()), "error", err)
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		if !allowed {
			httpx.Error(w, http.StatusUnauthorized, "Site access required to view more albums")
			return
		}
	}

	records, err := a.photos.ListByAlbum(r.Context(), id)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "album photos failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	accessible := records
	hasMore := false
	if !state.Granted {
		limit := a.settingInt(r.Context(), "app", "access.previewPhotoLimit", 10)
		if int64(len(accessible)) > limit {
			accessible = accessible[:limit]
			hasMore = true
		}
	}
	photosResponse, err := a.publicPhotoResponses(r, accessible, strconv.FormatInt(state.Version, 10))
	if err != nil {
		a.logger.ErrorContext(r.Context(), "album photo response failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	response := map[string]any{
		"id":              album.ID,
		"title":           album.Title,
		"description":     album.Description,
		"coverPhotoId":    album.CoverPhotoID,
		"isHidden":        album.IsHidden,
		"createdAt":       album.CreatedAt,
		"updatedAt":       album.UpdatedAt,
		"ownerUserId":     album.OwnerUserID,
		"owner":           album.Owner,
		"totalPhotoCount": len(records),
		"hasMorePhotos":   hasMore,
		"photos":          photosResponse,
	}
	httpx.JSON(w, http.StatusOK, response)
}

func parseAlbumIDPath(w http.ResponseWriter, rawID string) (int64, bool) {
	if !isASCIIDigits(rawID) {
		httpx.ErrorWithMessageData(
			w,
			http.StatusBadRequest,
			"Validation Error",
			invalidAlbumIDMessage,
			zodErrorData{Name: "ZodError", Message: invalidAlbumIDMessage},
		)
		return 0, false
	}
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id < 0 {
		httpx.ErrorWithMessageData(
			w,
			http.StatusBadRequest,
			"Validation Error",
			invalidAlbumIDMessage,
			zodErrorData{Name: "ZodError", Message: invalidAlbumIDMessage},
		)
		return 0, false
	}
	return id, true
}

func isASCIIDigits(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func (a *Application) accessStatus(w http.ResponseWriter, r *http.Request) {
	if a.photos == nil || a.albums == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	user := a.optionalUser(w, r)
	state := a.accessState(w, r, user != nil)
	photoLimit := a.settingInt(r.Context(), "app", "access.previewPhotoLimit", 10)
	albumLimit := a.settingInt(r.Context(), "app", "access.previewAlbumLimit", 1)
	totalPhotos, err := a.photos.CountPublic(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	totalAlbums, err := a.albums.CountPublic(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"required":      state.Enabled,
		"granted":       state.Granted,
		"photoLimit":    photoLimit,
		"albumLimit":    albumLimit,
		"totalPhotos":   totalPhotos,
		"totalAlbums":   totalAlbums,
		"hasMorePhotos": state.Enabled && !state.Granted && totalPhotos > photoLimit,
		"hasMoreAlbums": state.Enabled && !state.Granted && totalAlbums > albumLimit,
	})
}

func (a *Application) photoMap(w http.ResponseWriter, r *http.Request) {
	if a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	query := r.URL.Query()
	zoom := math.Max(0, math.Min(22, parseFiniteQuery(nodeQueryString(query, "zoom"), 2)))
	bounds := parseMapBounds(query)
	user := a.optionalUser(w, r)
	state := a.accessState(w, r, user != nil)
	limit := int64(0)
	if !state.Granted {
		limit = minInt64(a.settingInt(r.Context(), "app", "access.previewPhotoLimit", 10), 500)
	}
	records, err := a.photos.ListPublicMarkers(r.Context(), limit, bounds)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "public photo markers failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	markers := make([]map[string]any, 0, len(records))
	for _, record := range records {
		markers = append(markers, publicMarker(record))
	}
	clustered := clusterMarkers(markers, zoom)
	clustered["total"] = len(markers)
	httpx.JSON(w, http.StatusOK, clustered)
}

func (a *Application) photoAlbums(w http.ResponseWriter, r *http.Request) {
	if a.albums == nil || a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	photoID := r.PathValue("photoID")
	if photoID == "" {
		httpx.Error(w, http.StatusBadRequest, "Photo ID is required")
		return
	}
	if !a.requirePublicPhotoAccess(w, r, photoID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return
	}

	user := a.optionalUser(w, r)
	var userID *int64
	isAdmin := false
	if user != nil {
		userID = &user.ID
		isAdmin = user.IsAdmin != 0
	}
	result, err := a.albums.ListByPhoto(r.Context(), photoID, userID, isAdmin)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "photo albums failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (a *Application) photoLivePhoto(w http.ResponseWriter, r *http.Request) {
	if a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	photoID := r.PathValue("photoID")
	if photoID == "" {
		httpx.Error(w, http.StatusBadRequest, "Photo ID is required")
		return
	}
	if !a.requirePublicPhotoAccess(w, r, photoID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return
	}
	photo, err := a.photos.FindByID(r.Context(), photoID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "Photo not found")
			return
		}
		a.logger.ErrorContext(r.Context(), "live photo lookup failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Failed to get photo details")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id":                photo.ID,
		"title":             photo.Title,
		"isLivePhoto":       photo.IsLivePhoto != 0,
		"livePhotoVideoUrl": photo.LivePhotoVideoURL,
		"originalUrl":       photo.OriginalURL,
		"thumbnailUrl":      photo.ThumbnailURL,
	})
}

func (a *Application) photoReactions(w http.ResponseWriter, r *http.Request) {
	if a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	photoID := r.PathValue("photoID")
	if photoID == "" {
		httpx.Error(w, http.StatusBadRequest, "Photo ID is required")
		return
	}
	if !a.requirePublicPhotoAccess(w, r, photoID) {
		httpx.Error(w, http.StatusUnauthorized, "Site access required to view more photos")
		return
	}
	counts, err := a.photos.ReactionCounts(r.Context(), []string{photoID})
	if err != nil {
		a.logger.ErrorContext(r.Context(), "photo reactions failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	userReaction, err := a.photos.ReactionForFingerprint(
		r.Context(), photoID, requestFingerprint(r),
	)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "photo user reaction failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"photoId":      photoID,
		"reactions":    counts[photoID],
		"userReaction": userReaction,
	})
}

func (a *Application) photoReactionCounts(w http.ResponseWriter, r *http.Request) {
	if a.photos == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	values, ok := r.URL.Query()["ids"]
	// h3's getQuery() exposes a single empty query value as the empty string,
	// which is falsy, while repeated values are exposed as an array (and the
	// array remains truthy even when one of its entries is empty). Preserve that
	// distinction so ?ids= is rejected but ?ids=&ids=<photo> follows Node's
	// array semantics.
	if !ok || len(values) == 0 || (len(values) == 1 && values[0] == "") {
		httpx.ErrorWithMessageData(
			w,
			http.StatusBadRequest,
			"Server Error",
			"Photo IDs are required",
			nil,
		)
		return
	}
	requested := append([]string(nil), values...)
	accessible, err := a.filterAccessiblePhotoIDs(w, r, requested)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "photo reaction access filter failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if len(accessible) == 0 {
		httpx.JSON(w, http.StatusOK, map[string]map[string]int64{})
		return
	}
	result, err := a.photos.ReactionCounts(r.Context(), accessible)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "photo reaction counts failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (a *Application) photoStatus(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.photos == nil {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	records, err := a.photos.ListRecentForStatus(r.Context(), user.ID, user.IsAdmin != 0, 10)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "photo status failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	recentPhotos := make([]map[string]any, 0, len(records))
	for _, record := range records {
		recentPhotos = append(recentPhotos, privatePhotoRecord(record))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"recentPhotos": recentPhotos,
		"timestamp":    a.now().UTC().Format("2006-01-02T15:04:05.000Z"),
	})
}

func (a *Application) requirePublicPhotoAccess(w http.ResponseWriter, r *http.Request, photoID string) bool {
	user := a.optionalUser(w, r)
	state := a.accessState(w, r, user != nil)
	if state.Granted {
		return true
	}
	allowed, err := a.previewPhotoIDSet(r.Context())
	if err != nil {
		a.logger.WarnContext(r.Context(), "Go preview photo access lookup failed",
			"request_id", httpx.RequestID(r.Context()), "error", err)
		return false
	}
	_, ok := allowed[photoID]
	return ok
}

func (a *Application) filterAccessiblePhotoIDs(
	w http.ResponseWriter,
	r *http.Request,
	photoIDs []string,
) ([]string, error) {
	user := a.optionalUser(w, r)
	state := a.accessState(w, r, user != nil)
	if state.Granted {
		return photoIDs, nil
	}
	allowed, err := a.previewPhotoIDSet(r.Context())
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(photoIDs))
	for _, photoID := range photoIDs {
		if _, ok := allowed[photoID]; ok {
			result = append(result, photoID)
		}
	}
	return result, nil
}

func (a *Application) previewPhotoIDSet(ctx context.Context) (map[string]struct{}, error) {
	photoLimit := a.settingInt(ctx, "app", "access.previewPhotoLimit", 10)
	albumLimit := a.settingInt(ctx, "app", "access.previewAlbumLimit", 1)
	publicPhotos, err := a.photos.ListPublic(ctx, photoLimit)
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]struct{}, len(publicPhotos))
	for _, photo := range publicPhotos {
		allowed[photo.ID] = struct{}{}
	}

	publicAlbums, err := a.albums.ListPublic(ctx, albumLimit)
	if err != nil {
		return nil, err
	}
	for _, album := range publicAlbums {
		if album.CoverPhotoID != nil && *album.CoverPhotoID != "" {
			allowed[*album.CoverPhotoID] = struct{}{}
		}
		for index, photoID := range album.PhotoIDs {
			if index >= 3 {
				break
			}
			if photoID != "" {
				allowed[photoID] = struct{}{}
			}
		}
	}
	return allowed, nil
}

func requestFingerprint(r *http.Request) string {
	ip := requestIP(r)
	userAgent := headerOrUnknown(r.Header.Get("User-Agent"))
	acceptLanguage := headerOrUnknown(r.Header.Get("Accept-Language"))
	acceptEncoding := originalHeaderOrUnknown(r, "X-ChronoFrame-Original-Accept-Encoding", "Accept-Encoding")
	value := strings.Join([]string{ip, userAgent, acceptLanguage, acceptEncoding}, "|")
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func requestIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		if first, _, found := strings.Cut(forwarded, ","); found {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(forwarded)
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	if value := strings.TrimSpace(r.RemoteAddr); value != "" {
		return value
	}
	return "unknown"
}

func headerOrUnknown(value string) string {
	if strings.TrimSpace(value) == "" {
		return "unknown"
	}
	return value
}

func originalHeaderOrUnknown(r *http.Request, internalHeader string, fallbackHeader string) string {
	if values, ok := r.Header[http.CanonicalHeaderKey(internalHeader)]; ok {
		if len(values) == 0 {
			return "unknown"
		}
		return headerOrUnknown(values[0])
	}
	return headerOrUnknown(r.Header.Get(fallbackHeader))
}

func privatePhotoRecord(record photos.Record) map[string]any {
	return map[string]any{
		"id":                record.ID,
		"title":             record.Title,
		"description":       record.Description,
		"width":             record.Width,
		"height":            record.Height,
		"aspectRatio":       record.AspectRatio,
		"mediaType":         record.MediaType,
		"duration":          record.Duration,
		"videoCodec":        record.VideoCodec,
		"audioCodec":        record.AudioCodec,
		"videoPlaybackKey":  record.VideoPlaybackKey,
		"dateTaken":         record.DateTaken,
		"storageKey":        record.StorageKey,
		"contentHash":       record.ContentHash,
		"thumbnailKey":      record.ThumbnailKey,
		"displayKey":        record.DisplayKey,
		"fileSize":          record.FileSize,
		"lastModified":      record.LastModified,
		"originalUrl":       record.OriginalURL,
		"thumbnailUrl":      record.ThumbnailURL,
		"thumbnailHash":     record.ThumbnailHash,
		"tags":              record.Tags,
		"exif":              record.Exif,
		"latitude":          record.Latitude,
		"longitude":         record.Longitude,
		"country":           record.Country,
		"city":              record.City,
		"locationName":      record.LocationName,
		"isLivePhoto":       record.IsLivePhoto,
		"livePhotoVideoUrl": record.LivePhotoVideoURL,
		"livePhotoVideoKey": record.LivePhotoVideoKey,
		"ownerUserId":       record.OwnerUserID,
	}
}

func publicMarker(record photos.Marker) map[string]any {
	marker := map[string]any{
		"id":            record.ID,
		"title":         record.Title,
		"latitude":      record.Latitude,
		"longitude":     record.Longitude,
		"thumbnailUrl":  nil,
		"thumbnailHash": record.ThumbnailHash,
		"dateTaken":     record.DateTaken,
		"city":          record.City,
	}
	if record.ThumbnailKey != nil && *record.ThumbnailKey != "" {
		marker["thumbnailUrl"] = "/image/" + encodeStorageKey(*record.ThumbnailKey)
	}
	if exif := pickMapExif(record.Exif); exif != nil {
		marker["exif"] = exif
	}
	return marker
}

func pickMapExif(value any) map[string]any {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	result := make(map[string]any)
	for _, key := range []string{
		"DateTimeOriginal",
		"Make",
		"Model",
		"FocalLength",
		"FocalLengthIn35mmFormat",
		"ExposureTime",
		"GPSLatitude",
		"GPSLatitudeRef",
		"GPSLongitude",
		"GPSLongitudeRef",
		"GPSAltitude",
		"GPSAltitudeRef",
	} {
		if entry, exists := object[key]; exists {
			result[key] = entry
		}
	}
	return result
}

func parseFiniteQuery(value string, fallback float64) float64 {
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fallback
	}
	return parsed
}

func parseMapBounds(query url.Values) *photos.Bounds {
	west, okWest := parseOptionalFinite(nodeQueryString(query, "west"))
	east, okEast := parseOptionalFinite(nodeQueryString(query, "east"))
	south, okSouth := parseOptionalFinite(nodeQueryString(query, "south"))
	north, okNorth := parseOptionalFinite(nodeQueryString(query, "north"))
	if !okWest || !okEast || !okSouth || !okNorth {
		return nil
	}
	return &photos.Bounds{
		West:  math.Max(-180, math.Min(180, west)),
		East:  math.Max(-180, math.Min(180, east)),
		South: math.Max(-90, math.Min(90, south)),
		North: math.Max(-90, math.Min(90, north)),
	}
}

func parseOptionalFinite(value string) (float64, bool) {
	if value == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

type markerBucket struct {
	markers      []map[string]any
	longitudeSum float64
	latitudeSum  float64
}

func clusterMarkers(markers []map[string]any, zoom float64) map[string]any {
	const maxRenderedPoints = 520
	if len(markers) <= maxRenderedPoints || zoom >= 12 {
		return map[string]any{
			"markers":   markers,
			"clusters":  []map[string]any{},
			"clustered": false,
		}
	}
	cellSize := math.Max(0.00025, 0.01/math.Pow(2, zoom-10))
	buckets := buildMarkerBuckets(markers, cellSize)
	for attempts := 0; len(buckets) > maxRenderedPoints && attempts < 8; attempts++ {
		cellSize *= 1.8
		buckets = buildMarkerBuckets(markers, cellSize)
	}

	clusteredMarkers := make([]map[string]any, 0)
	clusters := make([]map[string]any, 0)
	clusterIndex := 0
	for _, bucket := range buckets {
		if len(bucket.markers) == 1 {
			clusteredMarkers = append(clusteredMarkers, bucket.markers[0])
			continue
		}
		clusteredPhotos := bucket.markers
		if len(clusteredPhotos) > 48 {
			clusteredPhotos = clusteredPhotos[:48]
		}
		clusters = append(clusters, map[string]any{
			"id":              "cluster-" + strconv.Itoa(clusterIndex),
			"latitude":        bucket.latitudeSum / float64(len(bucket.markers)),
			"longitude":       bucket.longitudeSum / float64(len(bucket.markers)),
			"count":           len(bucket.markers),
			"clusteredPhotos": clusteredPhotos,
		})
		clusterIndex++
	}
	return map[string]any{
		"markers":   clusteredMarkers,
		"clusters":  clusters,
		"clustered": true,
	}
}

func buildMarkerBuckets(markers []map[string]any, cellSize float64) []markerBucket {
	indexByKey := make(map[string]int)
	buckets := make([]markerBucket, 0)
	for _, marker := range markers {
		latitude, _ := marker["latitude"].(float64)
		longitude, _ := marker["longitude"].(float64)
		cellX := math.Floor((longitude + 180) / cellSize)
		cellY := math.Floor((latitude + 90) / cellSize)
		key := strconv.FormatFloat(cellX, 'f', -1, 64) + ":" +
			strconv.FormatFloat(cellY, 'f', -1, 64)
		index, exists := indexByKey[key]
		if !exists {
			index = len(buckets)
			indexByKey[key] = index
			buckets = append(buckets, markerBucket{})
		}
		bucket := &buckets[index]
		bucket.markers = append(bucket.markers, marker)
		bucket.longitudeSum += longitude
		bucket.latitudeSum += latitude
	}
	return buckets
}

func minInt64(value, maximum int64) int64 {
	if value < maximum {
		return value
	}
	return maximum
}

func encodeStorageKey(key string) string {
	parts := strings.Split(strings.TrimPrefix(key, "/"), "/")
	for index, part := range parts {
		parts[index] = encodeStorageSegment(part)
	}
	return strings.Join(parts, "/")
}

func encodeStorageSegment(value string) string {
	escaped := url.PathEscape(value)
	replacer := strings.NewReplacer(
		"%21", "!",
		"%27", "'",
		"%28", "(",
		"%29", ")",
		"%2A", "*",
		"%2a", "*",
	)
	return replacer.Replace(escaped)
}

func (a *Application) profile(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	user, err := a.auth.RequireUser(r.Context(), r)
	if err != nil {
		a.writeAuthError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, user)
}

func (a *Application) method(method string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			w.Header().Set("Allow", method)
			httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		handler(w, r)
	}
}

func (a *Application) readObjectMethod(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
			return
		}
		handler(w, r)
	}
}

func (a *Application) optionalUser(w http.ResponseWriter, r *http.Request) *auth.User {
	if a.auth == nil {
		return nil
	}
	user, err := a.auth.OptionalUser(r.Context(), r)
	if err != nil {
		if clearInvalidSessionCookie(w, err) {
			return nil
		}
		a.logger.WarnContext(r.Context(), "optional Go session lookup failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		return nil
	}
	return user
}

func (a *Application) accessState(
	w http.ResponseWriter,
	r *http.Request,
	authenticated bool,
) access.State {
	if a.access == nil {
		return access.State{Enabled: false, Granted: true, Version: 1}
	}
	state, err := a.access.State(r.Context(), r, authenticated)
	if err != nil {
		a.logger.WarnContext(r.Context(), "Go access state lookup failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		return access.State{Enabled: true, Granted: false, Version: 1}
	}
	if state.ClearAccessCookie {
		clearCookie(w, r, a.access.AccessCookieName())
	}
	return state
}

func (a *Application) settingInt(
	ctx context.Context,
	namespace string,
	key string,
	fallback int64,
) int64 {
	if a.settings == nil {
		return fallback
	}
	setting, err := a.settings.Value(ctx, namespace, key)
	if err != nil || !setting.Value.Valid {
		return fallback
	}
	value, ok := settings.NumberValue(setting.Value)
	if !ok || value < 1 || value != math.Trunc(value) ||
		value >= float64(math.MaxInt64) {
		return fallback
	}
	return int64(value)
}

func (a *Application) settingBool(
	ctx context.Context,
	namespace string,
	key string,
	fallback bool,
) bool {
	if a.settings == nil {
		return fallback
	}
	setting, err := a.settings.Value(ctx, namespace, key)
	if err != nil {
		return fallback
	}
	value, ok := settings.BooleanValue(setting.Value)
	if !ok {
		return fallback
	}
	return value
}

func (a *Application) publicPhotoResponses(
	r *http.Request,
	records []photos.Record,
	accessVersion string,
) ([]map[string]any, error) {
	owners, err := a.photos.Owners(r.Context(), records)
	if err != nil {
		return nil, err
	}
	response := make([]map[string]any, 0, len(records))
	for _, record := range records {
		value, err := photos.PublicPhoto(record, owners[record.OwnerUserID], accessVersion)
		if err != nil {
			return nil, err
		}
		response = append(response, value)
	}
	return response, nil
}

func uniquePhotoIDs(cover *string, ids []string, max int) []string {
	result := make([]string, 0, max+1)
	seen := make(map[string]struct{})
	appendID := func(value *string) {
		if value == nil || *value == "" {
			return
		}
		if _, exists := seen[*value]; exists {
			return
		}
		seen[*value] = struct{}{}
		result = append(result, *value)
	}
	appendID(cover)
	for _, id := range ids {
		if len(result) >= max+1 {
			break
		}
		value := id
		appendID(&value)
	}
	return result
}

func (a *Application) writeAuthError(w http.ResponseWriter, err error) {
	clearInvalidSessionCookie(w, err)
	switch {
	case errors.Is(err, auth.ErrUnauthorized):
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
	case errors.Is(err, auth.ErrForbidden):
		httpx.Error(w, http.StatusForbidden, "Forbidden")
	case errors.Is(err, redisx.ErrUnavailable):
		a.logger.Error("Go shared identity lookup failed", "error", err)
		httpx.Error(w, http.StatusServiceUnavailable, "Shared identity service unavailable")
	default:
		a.logger.Error("Go authentication failed", "error", err)
		httpx.Error(w, http.StatusServiceUnavailable, "Authentication unavailable")
	}
}

func (a *Application) live(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *Application) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	checks := map[string]string{"database": "ok"}
	ready := true

	status, err := a.database.Ready(ctx)
	if err != nil {
		ready = false
		checks["database"] = "failed"
		a.logger.WarnContext(ctx, "database readiness failed", "request_id", httpx.RequestID(ctx), "error", err)
	}
	if a.redis != nil {
		checks["redis"] = "ok"
		if err := a.redis.Ping(ctx); err != nil {
			ready = false
			checks["redis"] = "failed"
			a.logger.WarnContext(ctx, "redis readiness failed", "request_id", httpx.RequestID(ctx), "error", err)
		}
	} else {
		checks["redis"] = "disabled"
		if a.config.RedisRequired {
			ready = false
			checks["redis"] = "failed"
		}
	}
	mediaToolChecks := map[string]string{}
	if a.config.MediaToolPreflight {
		checks["mediaTools"] = "ok"
		if a.mediaTools == nil {
			mediaToolChecks["checker"] = "missing"
		} else {
			mediaToolChecks = a.mediaTools.Check(ctx)
		}
		if len(mediaToolChecks) > 0 {
			ready = false
			checks["mediaTools"] = "failed"
			a.logger.WarnContext(ctx, "media tool readiness failed",
				"request_id", httpx.RequestID(ctx), "tools", mediaToolChecks)
		}
	} else {
		checks["mediaTools"] = "disabled"
	}

	response := map[string]any{
		"status": "ready", "checks": checks,
		"schema": map[string]any{
			"latestMigrationMillis": status.LatestMigrationMillis,
			"migrationCount":        status.MigrationCount,
		},
	}
	if len(mediaToolChecks) > 0 {
		response["mediaTools"] = mediaToolChecks
	}
	if !ready {
		response["status"] = "not_ready"
		httpx.JSON(w, http.StatusServiceUnavailable, response)
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *Application) version(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]string{
		"backend": "go", "version": a.config.BackendVersion,
		"maturity": a.config.Maturity, "mode": a.config.Mode,
	})
}

func (a *Application) publicSettings(w http.ResponseWriter, r *http.Request) {
	data, err := a.settings.Public(r.Context())
	if err != nil {
		a.logger.ErrorContext(r.Context(), "public settings failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"timestamp": a.now().UnixMilli(),
		"data":      data,
	})
}

func (a *Application) accessConfig(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.settings == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	enabled := a.settingBool(r.Context(), "app", "access.enabled", false)
	password, err := a.settings.Value(r.Context(), "app", "access.passwordHash")
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		a.logger.ErrorContext(r.Context(), "access config password lookup failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"enabled":     enabled,
		"hasPassword": password.Value.Valid && password.Value.String != "",
		"photoLimit":  a.settingInt(r.Context(), "app", "access.previewPhotoLimit", 10),
		"albumLimit":  a.settingInt(r.Context(), "app", "access.previewAlbumLimit", 1),
	})
}

func (a *Application) adminUsers(w http.ResponseWriter, r *http.Request) {
	if a.auth == nil || a.database == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "Service Unavailable")
		return
	}
	if _, err := a.auth.RequireAdmin(r.Context(), r); err != nil {
		a.writeAuthError(w, err)
		return
	}
	rows, err := a.database.SQL().QueryContext(r.Context(), `
		SELECT
			id,
			name,
			email,
			avatar,
			created_at,
			is_admin,
			is_active,
			(SELECT COUNT(*) FROM photos WHERE photos.owner_user_id = users.id) AS photo_count,
			(SELECT COUNT(*) FROM albums WHERE albums.owner_user_id = users.id) AS album_count
		FROM users
		ORDER BY created_at ASC
	`)
	if err != nil {
		a.logger.ErrorContext(r.Context(), "admin users query failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	defer rows.Close()

	users := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id, isAdmin, isActive, createdAt, photoCount, albumCount int64
			username, email                                          string
			avatar                                                   *string
		)
		if err := rows.Scan(
			&id,
			&username,
			&email,
			&avatar,
			&createdAt,
			&isAdmin,
			&isActive,
			&photoCount,
			&albumCount,
		); err != nil {
			a.logger.ErrorContext(r.Context(), "admin user scan failed", "request_id", httpx.RequestID(r.Context()), "error", err)
			httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		users = append(users, map[string]any{
			"id":         id,
			"username":   username,
			"email":      email,
			"avatar":     avatar,
			"createdAt":  unixSecondsToISOString(createdAt),
			"isAdmin":    isAdmin,
			"isActive":   isActive != 0,
			"photoCount": photoCount,
			"albumCount": albumCount,
		})
	}
	if err := rows.Err(); err != nil {
		a.logger.ErrorContext(r.Context(), "admin users iteration failed", "request_id", httpx.RequestID(r.Context()), "error", err)
		httpx.Error(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, users)
}

func (a *Application) notFound(w http.ResponseWriter, _ *http.Request) {
	httpx.Error(w, http.StatusNotFound, "Not Found")
}

func unixSecondsToISOString(value int64) string {
	return time.Unix(value, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}
