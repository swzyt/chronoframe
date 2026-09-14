package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/swzyt/chronoframe/backend/go/internal/media"
	"github.com/swzyt/chronoframe/backend/go/internal/queue"
)

var goPipelineSupportedTaskTypes = []string{"photo", "live-photo-video", "video", "photo-reverse-geocoding", "photo-erase-location"}

var pipelineRuntimeLeaseRetryInterval = 2 * time.Second

type PipelineConsumer struct {
	application   *Application
	logger        *slog.Logger
	workerCount   int
	pollInterval  time.Duration
	processTaskFn func(context.Context, queue.Task) error

	mu      sync.RWMutex
	running bool
	workers []pipelineWorkerState
}

type pipelineWorkerState struct {
	WorkerID       string `json:"workerId"`
	IsProcessing   bool   `json:"isProcessing"`
	ProcessedCount int64  `json:"processedCount"`
	ErrorCount     int64  `json:"errorCount"`
	StartedAt      time.Time
}

func NewPipelineConsumer(application *Application, logger *slog.Logger, workerCount int64, pollInterval time.Duration) *PipelineConsumer {
	if logger == nil {
		logger = slog.Default()
	}
	if workerCount < 1 {
		workerCount = 1
	}
	if pollInterval <= 0 {
		pollInterval = 3 * time.Second
	}
	workers := make([]pipelineWorkerState, workerCount)
	startedAt := time.Now()
	for index := range workers {
		workers[index] = pipelineWorkerState{
			WorkerID:  fmt.Sprintf("go-worker-%d", index+1),
			StartedAt: startedAt,
		}
	}
	return &PipelineConsumer{
		application:  application,
		logger:       logger,
		workerCount:  int(workerCount),
		pollInterval: pollInterval,
		workers:      workers,
	}
}

func (consumer *PipelineConsumer) Run(ctx context.Context) {
	if consumer.application == nil || consumer.application.queue == nil {
		consumer.logger.Error("Go pipeline consumer cannot start without a queue repository")
		return
	}
	leaseContext, releaseLease, leaseAcquired := consumer.acquireRuntimeLease(ctx)
	if !leaseAcquired {
		return
	}
	defer releaseLease()
	claimContext, stopClaiming := context.WithCancel(leaseContext)
	stopOnShutdown := context.AfterFunc(ctx, stopClaiming)
	defer func() {
		stopOnShutdown()
		stopClaiming()
	}()

	consumer.mu.Lock()
	if consumer.running {
		consumer.mu.Unlock()
		return
	}
	consumer.running = true
	consumer.mu.Unlock()
	defer func() {
		consumer.mu.Lock()
		consumer.running = false
		for index := range consumer.workers {
			consumer.workers[index].IsProcessing = false
		}
		consumer.mu.Unlock()
		consumer.logger.Info("Go pipeline consumer stopped")
	}()

	consumer.logger.Info("Go pipeline consumer starting",
		"workers", consumer.workerCount,
		"poll_interval", consumer.pollInterval.String(),
		"supported_task_types", goPipelineSupportedTaskTypes,
	)
	if resetCount, err := consumer.application.queue.ResetExpiredClaims(claimContext, time.Now()); err != nil {
		consumer.logger.Warn("Go pipeline consumer failed to reset expired queue task leases", "error", err)
	} else if resetCount > 0 {
		consumer.logger.Warn("Go pipeline consumer reset expired queue task leases", "count", resetCount)
	}

	var group sync.WaitGroup
	for index := range consumer.workers {
		workerIndex := index
		group.Add(1)
		go func() {
			defer group.Done()
			consumer.workerLoop(claimContext, leaseContext, workerIndex)
		}()
	}

	select {
	case <-ctx.Done():
		consumer.logger.Info("Go pipeline consumer stopping claims and draining in-flight tasks")
		stopClaiming()
	case <-leaseContext.Done():
		stopClaiming()
	}
	group.Wait()
}

func (consumer *PipelineConsumer) acquireRuntimeLease(parent context.Context) (context.Context, func(), bool) {
	leaseStore, ok := consumer.application.redis.(runtimeLeaseStore)
	if !ok || leaseStore == nil {
		consumer.logger.Warn("Starting Go pipeline consumer without Redis runtime lease because shared Redis is not configured")
		leaseContext, cancelLease := context.WithCancel(context.Background())
		return leaseContext, cancelLease, true
	}
	key, err := runtimeLeaseKey(consumer.application.config.Environment, "pipeline-consumer")
	if err != nil {
		consumer.logger.Error("Go pipeline consumer runtime lease key is invalid", "error", err)
		return parent, func() {}, false
	}
	value, err := runtimeLeaseValue("go", "", time.Now())
	if err != nil {
		consumer.logger.Error("Go pipeline consumer runtime lease value is invalid", "error", err)
		return parent, func() {}, false
	}
	retryInterval := pipelineRuntimeLeaseRetryInterval
	if retryInterval <= 0 {
		retryInterval = 2 * time.Second
	}
	loggedHeldLease := false
	for {
		if parent.Err() != nil {
			return parent, func() {}, false
		}
		acquired, err := leaseStore.TryAcquireRuntimeLease(parent, key, value, defaultRuntimeLeaseTTL)
		if err != nil {
			if parent.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return parent, func() {}, false
			}
			consumer.logger.Error("Go pipeline consumer failed to acquire runtime lease; retrying", "lease_key", key, "retry_interval", retryInterval.String(), "error", err)
		} else if acquired {
			if loggedHeldLease {
				consumer.logger.Info("Go pipeline consumer acquired runtime lease after waiting", "lease_key", key)
			}
			break
		} else if !loggedHeldLease {
			consumer.logger.Warn("Go pipeline consumer runtime lease is already held; waiting to retry", "lease_key", key, "retry_interval", retryInterval.String(), "lease_ttl", defaultRuntimeLeaseTTL.String())
			loggedHeldLease = true
		}

		select {
		case <-parent.Done():
			return parent, func() {}, false
		case <-time.After(retryInterval):
		}
	}

	leaseContext, cancelLease := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(defaultRuntimeLeaseTTL / 3)
		defer ticker.Stop()
		for {
			select {
			case <-leaseContext.Done():
				return
			case <-ticker.C:
				refreshed, err := leaseStore.RefreshRuntimeLease(leaseContext, key, value, defaultRuntimeLeaseTTL)
				if err != nil || !refreshed {
					consumer.logger.Error("Go pipeline consumer runtime lease lost", "lease_key", key, "error", err)
					cancelLease()
					return
				}
			}
		}
	}()

	release := func() {
		cancelLease()
		<-done
		releaseContext, releaseCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer releaseCancel()
		if err := leaseStore.ReleaseRuntimeLease(releaseContext, key, value); err != nil {
			consumer.logger.Warn("Failed to release Go pipeline consumer runtime lease", "lease_key", key, "error", err)
		}
	}
	return leaseContext, release, true
}

func (consumer *PipelineConsumer) workerLoop(claimContext context.Context, taskContext context.Context, workerIndex int) {
	consumer.processNext(claimContext, taskContext, workerIndex)
	ticker := time.NewTicker(consumer.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-claimContext.Done():
			return
		case <-ticker.C:
			consumer.processNext(claimContext, taskContext, workerIndex)
		}
	}
}

func (consumer *PipelineConsumer) processNext(claimContext context.Context, taskParentContext context.Context, workerIndex int) {
	workerID := consumer.workerID(workerIndex)
	consumer.setWorkerProcessing(workerIndex, true)
	defer consumer.setWorkerProcessing(workerIndex, false)

	task, err := consumer.application.queue.ClaimNext(claimContext, goPipelineSupportedTaskTypes, workerID, time.Now())
	if err != nil {
		consumer.incrementWorkerError(workerIndex)
		consumer.logger.Error("Go pipeline consumer failed to claim task", "worker", workerID, "error", err)
		return
	}
	if task == nil {
		return
	}

	consumer.logger.Info("Go pipeline consumer claimed task", "worker", workerID, "task_id", task.ID, "type", queuePayloadType(task.Payload))
	taskContext, stopHeartbeat := consumer.startTaskLeaseHeartbeat(taskParentContext, workerID, *task)
	defer stopHeartbeat()

	if err := consumer.runTask(taskContext, *task); err != nil {
		consumer.incrementWorkerError(workerIndex)
		if errors.Is(err, queue.ErrTaskLeaseLost) {
			consumer.logger.Warn("Go pipeline consumer task lease was lost; skipping status writeback", "worker", workerID, "task_id", task.ID, "error", err)
			return
		}
		message := err.Error()
		if markErr := consumer.application.queue.MarkFailedWithRetry(taskContext, task.ID, task.ClaimTokenValue(), message, time.Now()); markErr != nil {
			consumer.logger.Error("Go pipeline consumer failed to mark task failed", "worker", workerID, "task_id", task.ID, "error", markErr)
			return
		}
		consumer.logger.Error("Go pipeline consumer task failed", "worker", workerID, "task_id", task.ID, "error", err)
		return
	}
	if err := consumer.application.queue.MarkCompleted(taskContext, task.ID, task.ClaimTokenValue()); err != nil {
		consumer.incrementWorkerError(workerIndex)
		consumer.logger.Error("Go pipeline consumer failed to mark task completed", "worker", workerID, "task_id", task.ID, "error", err)
		return
	}
	consumer.incrementWorkerProcessed(workerIndex)
	consumer.logger.Info("Go pipeline consumer completed task", "worker", workerID, "task_id", task.ID)
}

func (consumer *PipelineConsumer) runTask(ctx context.Context, task queue.Task) error {
	if consumer.processTaskFn != nil {
		return consumer.processTaskFn(ctx, task)
	}
	return consumer.processTask(ctx, task)
}

func (consumer *PipelineConsumer) startTaskLeaseHeartbeat(ctx context.Context, workerID string, task queue.Task) (context.Context, func()) {
	claimToken := task.ClaimTokenValue()
	if claimToken == "" || consumer.application == nil || consumer.application.queue == nil {
		return ctx, func() {}
	}
	taskContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(queue.DefaultTaskLeaseTTL / 3)
		defer ticker.Stop()
		for {
			select {
			case <-taskContext.Done():
				return
			case <-ticker.C:
				refreshed, err := consumer.application.queue.RefreshClaim(taskContext, task.ID, claimToken, time.Now())
				if err != nil || !refreshed {
					consumer.logger.Warn("Go pipeline consumer task lease refresh failed; canceling task context",
						"worker", workerID, "task_id", task.ID, "error", err)
					cancel()
					return
				}
			}
		}
	}()
	stop := func() {
		cancel()
		<-done
	}
	return taskContext, stop
}

func (consumer *PipelineConsumer) processTask(ctx context.Context, task queue.Task) error {
	switch queuePayloadType(task.Payload) {
	case "photo":
		return consumer.application.processPhotoQueueTask(ctx, task)
	case "live-photo-video":
		return consumer.application.processLivePhotoVideoQueueTask(ctx, task)
	case "video":
		return consumer.application.processVideoQueueTask(ctx, task)
	case "photo-reverse-geocoding":
		return consumer.application.processPhotoReverseGeocodingQueueTask(ctx, task)
	case "photo-erase-location":
		return consumer.application.processPhotoEraseLocationQueueTask(ctx, task)
	default:
		return fmt.Errorf("unsupported Go pipeline task type %q", queuePayloadType(task.Payload))
	}
}

func (consumer *PipelineConsumer) workerID(index int) string {
	consumer.mu.RLock()
	defer consumer.mu.RUnlock()
	if index < 0 || index >= len(consumer.workers) {
		return "go-worker-unknown"
	}
	return consumer.workers[index].WorkerID
}

func (consumer *PipelineConsumer) setWorkerProcessing(index int, processing bool) {
	consumer.mu.Lock()
	defer consumer.mu.Unlock()
	if index >= 0 && index < len(consumer.workers) {
		consumer.workers[index].IsProcessing = processing
	}
}

func (consumer *PipelineConsumer) incrementWorkerProcessed(index int) {
	consumer.mu.Lock()
	defer consumer.mu.Unlock()
	if index >= 0 && index < len(consumer.workers) {
		consumer.workers[index].ProcessedCount++
	}
}

func (consumer *PipelineConsumer) incrementWorkerError(index int) {
	consumer.mu.Lock()
	defer consumer.mu.Unlock()
	if index >= 0 && index < len(consumer.workers) {
		consumer.workers[index].ErrorCount++
	}
}

func (consumer *PipelineConsumer) PoolStats() map[string]any {
	consumer.mu.RLock()
	defer consumer.mu.RUnlock()

	workers := make([]map[string]any, 0, len(consumer.workers))
	var totalProcessed, totalErrors, activeWorkers int64
	for _, worker := range consumer.workers {
		totalProcessed += worker.ProcessedCount
		totalErrors += worker.ErrorCount
		if worker.IsProcessing {
			activeWorkers++
		}
		workers = append(workers, map[string]any{
			"workerId":       worker.WorkerID,
			"isProcessing":   worker.IsProcessing,
			"processedCount": worker.ProcessedCount,
			"errorCount":     worker.ErrorCount,
			"uptime":         int64(time.Since(worker.StartedAt).Seconds()),
			"successRate":    workerSuccessRate(worker.ProcessedCount, worker.ErrorCount),
		})
	}

	return map[string]any{
		"isActive":           consumer.running,
		"workerCount":        len(consumer.workers),
		"totalWorkers":       len(consumer.workers),
		"activeWorkers":      activeWorkers,
		"totalProcessed":     totalProcessed,
		"totalErrors":        totalErrors,
		"averageSuccessRate": averageWorkerSuccessRate(consumer.workers),
		"workers":            workers,
		"supportedTaskTypes": append([]string{}, goPipelineSupportedTaskTypes...),
	}
}

func workerSuccessRate(processed int64, errorsCount int64) float64 {
	total := processed + errorsCount
	if total <= 0 {
		return 0
	}
	return float64(processed) / float64(total) * 100
}

func averageWorkerSuccessRate(workers []pipelineWorkerState) float64 {
	var total float64
	var withActivity int64
	for _, worker := range workers {
		if worker.ProcessedCount == 0 && worker.ErrorCount == 0 {
			continue
		}
		total += workerSuccessRate(worker.ProcessedCount, worker.ErrorCount)
		withActivity++
	}
	if withActivity == 0 {
		return 0
	}
	return total / float64(withActivity)
}

func (a *Application) processLivePhotoVideoQueueTask(ctx context.Context, task queue.Task) error {
	videoKey := queuePayloadString(task.Payload, "storageKey")
	if strings.TrimSpace(videoKey) == "" {
		return errors.New("live-photo-video task is missing storageKey")
	}
	provider, err := a.mediaProvider(ctx)
	if err != nil {
		return fmt.Errorf("load storage provider: %w", err)
	}
	if err := ensureStorageObjectExists(ctx, provider, videoKey); err != nil {
		return err
	}
	photoID, found := a.findPhotoForLiveVideo(ctx, videoKey)
	if !found {
		a.logger.InfoContext(ctx, "No matching photo found for Live Photo video yet", "video_key", videoKey)
		return nil
	}
	publicURL := a.publicStorageURL(provider, videoKey)
	_, err = a.database.SQL().ExecContext(ctx, `
		UPDATE photos
		SET is_live_photo = 1, live_photo_video_url = ?, live_photo_video_key = ?
		WHERE id = ?
	`, publicURL, videoKey, photoID)
	if err != nil {
		return fmt.Errorf("update live photo link: %w", err)
	}
	return nil
}

func ensureStorageObjectExists(ctx context.Context, provider *media.Provider, key string) error {
	if provider == nil {
		return errors.New("storage provider unavailable")
	}
	if _, err := provider.Meta(ctx, key); err == nil {
		return nil
	}
	if data, _, err := provider.Get(ctx, key); err == nil && len(data) >= 0 {
		return nil
	}
	return fmt.Errorf("storage object %s not found", key)
}

func queuePayloadType(payload any) string {
	return queuePayloadString(payload, "type")
}

func queuePayloadString(payload any, key string) string {
	object, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	value, ok := object[key]
	if !ok {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case fmt.Stringer:
		return typed.String()
	default:
		return fmt.Sprint(typed)
	}
}
