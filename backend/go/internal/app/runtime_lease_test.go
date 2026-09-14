package app

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRuntimeLeaseKeyMatchesSharedStateNamespace(t *testing.T) {
	key, err := runtimeLeaseKey("development", "pipeline-consumer")
	if err != nil {
		t.Fatal(err)
	}
	if key != "cf:v1:development:lease:pipeline-consumer" {
		t.Fatalf("key = %q", key)
	}
	if _, err := runtimeLeaseKey("Production", "pipeline-consumer"); err == nil {
		t.Fatal("expected invalid environment error")
	}
	if _, err := runtimeLeaseKey("development", "migrator"); err == nil {
		t.Fatal("expected unsupported actor error")
	}
}

func TestRuntimeLeaseValueRecordsOwnerInstanceAndTimestamp(t *testing.T) {
	acquiredAt := time.Date(2026, 9, 11, 8, 9, 10, 123_000_000, time.UTC)
	value, err := runtimeLeaseValue("go", "go-test-instance", acquiredAt)
	if err != nil {
		t.Fatal(err)
	}
	var record runtimeLeaseRecord
	if err := json.Unmarshal([]byte(value), &record); err != nil {
		t.Fatal(err)
	}
	if record.SchemaVersion != 1 || record.Owner != "go" || record.Instance != "go-test-instance" || record.AcquiredAt != acquiredAt.UnixMilli() {
		t.Fatalf("record = %#v", record)
	}
}
