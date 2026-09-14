package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/access"
	"github.com/swzyt/chronoframe/backend/go/internal/albums"
	"github.com/swzyt/chronoframe/backend/go/internal/app"
	"github.com/swzyt/chronoframe/backend/go/internal/auth"
	"github.com/swzyt/chronoframe/backend/go/internal/photos"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/config"
	platformdb "github.com/swzyt/chronoframe/backend/go/internal/platform/db"
	"github.com/swzyt/chronoframe/backend/go/internal/platform/redisx"
	"github.com/swzyt/chronoframe/backend/go/internal/queue"
	"github.com/swzyt/chronoframe/backend/go/internal/settings"
	"github.com/swzyt/chronoframe/backend/go/internal/storage"
	"github.com/swzyt/chronoframe/backend/go/internal/uploads"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	if err := run(logger); err != nil {
		logger.Error("Go backend stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	database, err := platformdb.Open(ctx, cfg.DatabaseURL, platformdb.Options{
		ReadOnly: false, RequireWAL: cfg.DBMigrator != "go", MinMigrationMillis: cfg.SchemaMinCreatedAt,
	})
	if err != nil {
		return err
	}
	defer database.Close()
	var schemaStatus platformdb.SchemaStatus
	if cfg.DBMigrator == "go" {
		schemaStatus, err = database.Migrate(ctx)
	} else {
		schemaStatus, err = database.Check(ctx)
	}
	if err != nil {
		return fmt.Errorf("SQLite startup preflight: %w", err)
	}
	logger.Info("SQLite startup preflight complete",
		"migration_count", schemaStatus.MigrationCount,
		"latest_migration_millis", schemaStatus.LatestMigrationMillis,
	)
	settingsService := settings.NewService(settings.NewSQLiteRepository(database.SQL()))
	if err := settingsService.InitDefaults(ctx); err != nil {
		return fmt.Errorf("initialize default settings: %w", err)
	}
	logger.Info("Default settings initialized", "setting_count", len(settings.DefaultSettings))
	if cfg.MigrateOnly {
		logger.Info("Go database migration completed in migrate-only mode")
		return nil
	}

	var redisClient *redisx.Client
	var redisHealth app.RedisHealth
	if cfg.RedisURL != "" {
		redisClient, err = redisx.New(cfg.RedisURL, cfg.RedisUsername, cfg.RedisPassword)
		if err != nil {
			return err
		}
		defer redisClient.Close()
		redisHealth = redisClient
	}

	var sharedSessions *redisx.SessionStore
	if redisClient != nil {
		sharedSessions, err = redisx.NewSessionStore(redisClient.Raw(), cfg.Environment)
		if err != nil {
			return err
		}
	}
	albumsRepository := albums.NewSQLiteRepository(database.SQL())
	photosRepository := photos.NewSQLiteRepository(database.SQL())
	queueRepository := queue.NewSQLiteRepository(database.SQL())
	storageRepository := storage.NewSQLiteRepository(database.SQL())
	uploadsRepository := uploads.NewSQLiteRepository(database.SQL())
	authService := auth.NewService(auth.NewSQLiteRepository(database.SQL()), sharedSessions, cfg.SessionCookie)
	accessService := access.NewService(settingsService, sharedSessions, cfg.AccessCookie)
	application := app.NewApplication(app.Dependencies{
		Config: cfg, Logger: logger, Database: database, Redis: redisHealth,
		Settings: settingsService, Albums: albumsRepository, Photos: photosRepository,
		Auth: authService, Access: accessService, Queue: queueRepository,
		Storage: storageRepository, Uploads: uploadsRepository,
	})
	handler := application.Handler()
	var backgroundActors sync.WaitGroup
	if cfg.PipelineConsumer == "go" {
		pipelineConsumer := app.NewPipelineConsumer(
			application,
			logger.With("component", "pipeline-consumer"),
			cfg.PipelineWorkerCount,
			cfg.PipelinePollInterval,
		)
		application.SetPipelineConsumer(pipelineConsumer)
		backgroundActors.Add(1)
		go func() {
			defer backgroundActors.Done()
			pipelineConsumer.Run(ctx)
		}()
	}
	if cfg.BackupScheduler == "go" {
		backupScheduler := app.NewBackupScheduler(
			application,
			logger.With("component", "db-backup"),
			cfg.BackupScheduleRefresh,
		)
		backgroundActors.Add(1)
		go func() {
			defer backgroundActors.Done()
			backupScheduler.Run(ctx)
		}()
	}
	server := &http.Server{
		Addr: cfg.Address, Handler: handler,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout, ReadTimeout: cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout, IdleTimeout: cfg.IdleTimeout,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("Go backend listening", "address", cfg.Address, "environment", cfg.Environment, "version", cfg.BackendVersion)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownContext, shutdownCancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer shutdownCancel()
		shutdownErr := server.Shutdown(shutdownContext)
		waitErr := waitBackgroundActors(&backgroundActors, cfg.ShutdownTimeout)
		return errors.Join(shutdownErr, waitErr)
	case err := <-serverErrors:
		cancel()
		waitErr := waitBackgroundActors(&backgroundActors, cfg.ShutdownTimeout)
		if errors.Is(err, http.ErrServerClosed) {
			return waitErr
		}
		return errors.Join(err, waitErr)
	}
}

func waitBackgroundActors(group *sync.WaitGroup, timeout time.Duration) error {
	done := make(chan struct{})
	go func() {
		defer close(done)
		group.Wait()
	}()
	if timeout <= 0 {
		<-done
		return nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		return fmt.Errorf("timed out after %s waiting for background actors to stop", timeout)
	}
}
