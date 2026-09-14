package app

import (
	"context"
	"testing"
)

func TestResolvedSettingsCacheVersionKeyDefaults(t *testing.T) {
	t.Setenv(settingsCacheVersionKeyEnv, "")

	if got := resolvedSettingsCacheVersionKey(); got != defaultSettingsCacheVersionKey {
		t.Fatalf("expected default settings cache version key %q, got %q", defaultSettingsCacheVersionKey, got)
	}
}

func TestResolvedSettingsCacheVersionKeyTrimsCustomValue(t *testing.T) {
	t.Setenv(settingsCacheVersionKeyEnv, " chronoframe:test-settings-version ")

	if got := resolvedSettingsCacheVersionKey(); got != "chronoframe:test-settings-version" {
		t.Fatalf("expected custom settings cache version key, got %q", got)
	}
}

func TestPublishSettingsCacheVersionIncrementsSharedRedisKey(t *testing.T) {
	t.Setenv(settingsCacheVersionKeyEnv, "chronoframe:test-settings-version")
	redis := &fakeSettingsCacheVersionRedis{}
	application := &Application{redis: redis}

	application.publishSettingsCacheVersion(context.Background())

	if redis.key != "chronoframe:test-settings-version" {
		t.Fatalf("expected shared settings cache version key to be incremented, got %q", redis.key)
	}
	if redis.calls != 1 {
		t.Fatalf("expected one increment call, got %d", redis.calls)
	}
}

type fakeSettingsCacheVersionRedis struct {
	key   string
	calls int
}

func (f *fakeSettingsCacheVersionRedis) Ping(context.Context) error {
	return nil
}

func (f *fakeSettingsCacheVersionRedis) GetString(context.Context, string) (string, error) {
	return "", nil
}

func (f *fakeSettingsCacheVersionRedis) Incr(_ context.Context, key string) (int64, error) {
	f.key = key
	f.calls++
	return int64(f.calls), nil
}
