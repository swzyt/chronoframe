package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"time"
)

const defaultRuntimeLeaseTTL = 30 * time.Second

var runtimeLeaseEnvironmentPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

type runtimeLeaseStore interface {
	TryAcquireRuntimeLease(context.Context, string, string, time.Duration) (bool, error)
	RefreshRuntimeLease(context.Context, string, string, time.Duration) (bool, error)
	ReleaseRuntimeLease(context.Context, string, string) error
}

type runtimeLeaseRecord struct {
	SchemaVersion int    `json:"schemaVersion"`
	Owner         string `json:"owner"`
	Instance      string `json:"instance"`
	AcquiredAt    int64  `json:"acquiredAt"`
}

func runtimeLeaseKey(environment string, actor string) (string, error) {
	if !runtimeLeaseEnvironmentPattern.MatchString(environment) {
		return "", errors.New("environment has an invalid shared-state namespace")
	}
	if actor != "pipeline-consumer" && actor != "backup-scheduler" {
		return "", fmt.Errorf("unsupported runtime lease actor %q", actor)
	}
	return fmt.Sprintf("cf:v1:%s:lease:%s", environment, actor), nil
}

func runtimeLeaseValue(owner string, instance string, acquiredAt time.Time) (string, error) {
	if owner != "node" && owner != "go" {
		return "", fmt.Errorf("unsupported runtime lease owner %q", owner)
	}
	if instance == "" {
		instance = randomRuntimeLeaseInstance(owner)
	}
	value, err := json.Marshal(runtimeLeaseRecord{
		SchemaVersion: 1,
		Owner:         owner,
		Instance:      instance,
		AcquiredAt:    acquiredAt.UnixMilli(),
	})
	if err != nil {
		return "", err
	}
	return string(value), nil
}

func randomRuntimeLeaseInstance(owner string) string {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown-host"
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return fmt.Sprintf("%s:%s:%d:%d", owner, hostname, os.Getpid(), time.Now().UnixNano())
	}
	return fmt.Sprintf("%s:%s:%d:%s", owner, hostname, os.Getpid(), hex.EncodeToString(random))
}
