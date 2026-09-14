package settings

import (
	"context"
	"fmt"
)

// DefaultSetting is the Go copy of Node's DEFAULT_SETTINGS metadata. The
// generated values use the same SQLite TEXT representation as Node's
// SettingsManager.init.
type DefaultSetting struct {
	Namespace    string
	Key          string
	Type         string
	Value        *string
	DefaultValue *string
	Label        *string
	Description  *string
	IsPublic     bool
	IsReadonly   bool
	IsSecret     bool
	Enum         *string
}

func (s *Service) InitDefaults(ctx context.Context) error {
	repository, ok := s.repository.(*SQLiteRepository)
	if !ok {
		return fmt.Errorf("settings repository does not support default initialization")
	}
	return repository.InitDefaults(ctx, DefaultSettings)
}
