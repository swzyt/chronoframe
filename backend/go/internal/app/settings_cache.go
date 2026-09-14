package app

import (
	"context"
	"os"
	"strings"
)

const (
	settingsCacheVersionKeyEnv     = "CFRAME_SETTINGS_CACHE_VERSION_KEY"
	defaultSettingsCacheVersionKey = "chronoframe:settings:version"
)

type settingsCacheVersionStore interface {
	Incr(context.Context, string) (int64, error)
}

func (a *Application) setSetting(
	ctx context.Context,
	namespace string,
	key string,
	input any,
	updatedBy *int64,
	sudo ...bool,
) (any, error) {
	value, err := a.settings.Set(ctx, namespace, key, input, updatedBy, sudo...)
	if err != nil {
		return nil, err
	}
	a.publishSettingsCacheVersion(ctx)
	return value, nil
}

func (a *Application) publishSettingsCacheVersion(ctx context.Context) {
	store, ok := a.redis.(settingsCacheVersionStore)
	if !ok {
		return
	}

	if _, err := store.Incr(ctx, resolvedSettingsCacheVersionKey()); err != nil && a.logger != nil {
		a.logger.WarnContext(ctx, "Failed to publish shared settings cache version", "error", err)
	}
}

func resolvedSettingsCacheVersionKey() string {
	value := strings.TrimSpace(os.Getenv(settingsCacheVersionKeyEnv))
	if value == "" {
		return defaultSettingsCacheVersionKey
	}
	return value
}
