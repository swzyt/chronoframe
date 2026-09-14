package app

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

const defaultBackupScheduleRefreshInterval = time.Minute

type BackupScheduler struct {
	application     *Application
	logger          *slog.Logger
	refreshInterval time.Duration

	mu                sync.Mutex
	enabled           bool
	schedule          backupCronSchedule
	scheduleSignature string
	lastMatchStamp    string
	backupRunning     bool
}

func NewBackupScheduler(application *Application, logger *slog.Logger, refreshInterval time.Duration) *BackupScheduler {
	if logger == nil {
		logger = slog.Default()
	}
	if refreshInterval <= 0 {
		refreshInterval = defaultBackupScheduleRefreshInterval
	}
	return &BackupScheduler{
		application:     application,
		logger:          logger,
		refreshInterval: refreshInterval,
	}
}

func (scheduler *BackupScheduler) Run(ctx context.Context) {
	scheduler.logger.Info("Go database backup scheduler starting")
	if err := scheduler.Refresh(ctx); err != nil {
		scheduler.logger.Error("Failed to initialize Go database backup schedule", "error", err)
	}

	runTicker := time.NewTicker(time.Second)
	defer runTicker.Stop()
	refreshTicker := time.NewTicker(scheduler.refreshInterval)
	defer refreshTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			scheduler.disable()
			scheduler.logger.Info("Go database backup scheduler stopped")
			return
		case now := <-runTicker.C:
			scheduler.maybeRun(now)
		case <-refreshTicker.C:
			if err := scheduler.Refresh(ctx); err != nil {
				scheduler.logger.Error("Failed to refresh Go database backup schedule", "error", err)
			}
		}
	}
}

func (scheduler *BackupScheduler) Refresh(ctx context.Context) error {
	if scheduler.application == nil {
		return fmt.Errorf("backup scheduler requires an application")
	}
	settings, err := scheduler.application.loadDatabaseBackupSettings(ctx)
	if err != nil {
		return err
	}
	schedule, signature, enabled, parseErr := backupScheduleFromSettings(settings)

	scheduler.mu.Lock()
	changed := scheduler.enabled != enabled || scheduler.scheduleSignature != signature
	if changed {
		scheduler.enabled = enabled
		scheduler.schedule = schedule
		scheduler.scheduleSignature = signature
		scheduler.lastMatchStamp = ""
	}
	scheduler.mu.Unlock()

	if changed {
		if enabled {
			scheduler.logger.Info("Go database backup scheduled",
				"cron", schedule.expression,
				"timezone", schedule.timezone,
			)
		} else {
			scheduler.logger.Info("Go database backup schedule disabled")
		}
	}
	return parseErr
}

func backupScheduleFromSettings(settings databaseBackupSettings) (backupCronSchedule, string, bool, error) {
	if !settings.Enabled {
		return backupCronSchedule{}, "", false, nil
	}
	schedule, err := parseBackupCronSchedule(settings.Cron, settings.Timezone)
	if err != nil {
		return backupCronSchedule{}, "", false, err
	}
	signature := strings.TrimSpace(schedule.expression) + "|" + schedule.timezone
	return schedule, signature, true, nil
}

func (scheduler *BackupScheduler) maybeRun(now time.Time) {
	scheduler.mu.Lock()
	if !scheduler.enabled || !scheduler.schedule.matches(now) {
		scheduler.mu.Unlock()
		return
	}
	stamp := scheduler.schedule.matchStamp(now)
	if stamp == "" || stamp == scheduler.lastMatchStamp {
		scheduler.mu.Unlock()
		return
	}
	scheduler.lastMatchStamp = stamp
	scheduler.mu.Unlock()

	go scheduler.execute()
}

func (scheduler *BackupScheduler) execute() {
	scheduler.mu.Lock()
	if scheduler.backupRunning {
		scheduler.mu.Unlock()
		scheduler.logger.Warn("Skipping Go database backup because a backup is already running")
		return
	}
	scheduler.backupRunning = true
	scheduler.mu.Unlock()

	defer func() {
		scheduler.mu.Lock()
		scheduler.backupRunning = false
		scheduler.mu.Unlock()
	}()

	result, err := scheduler.application.runDatabaseBackup(context.Background())
	if err != nil {
		scheduler.logger.Error("Scheduled Go database backup failed", "error", err)
		return
	}
	scheduler.logger.Info("Scheduled Go database backup finished",
		"file", result["fileName"],
		"sent_to", result["sentTo"],
	)
}

func (scheduler *BackupScheduler) disable() {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	scheduler.enabled = false
	scheduler.schedule = backupCronSchedule{}
	scheduler.scheduleSignature = ""
	scheduler.lastMatchStamp = ""
}
