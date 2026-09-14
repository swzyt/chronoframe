package app

import (
	"testing"
	"time"
)

func TestBackupCronScheduleMatchesFiveFieldExpressionInTimezone(t *testing.T) {
	schedule, err := parseBackupCronSchedule("0 3 * * *", "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}

	if !schedule.matches(time.Date(2026, 9, 10, 19, 0, 0, 0, time.UTC)) {
		t.Fatal("default backup cron should match 03:00 Asia/Shanghai")
	}
	if schedule.matches(time.Date(2026, 9, 10, 19, 0, 1, 0, time.UTC)) {
		t.Fatal("five-field cron should only match second zero")
	}
	if schedule.matches(time.Date(2026, 9, 10, 18, 59, 0, 0, time.UTC)) {
		t.Fatal("default backup cron should not match one minute early")
	}
}

func TestBackupCronScheduleSupportsSecondsStepsRangesAndNames(t *testing.T) {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	schedule, err := parseBackupCronSchedule("30 */15 9-17 * JAN,MAR MON-FRI", "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}

	if !schedule.matches(time.Date(2026, 1, 5, 9, 15, 30, 0, location)) {
		t.Fatal("cron with seconds, step, range, month name, and weekday range should match")
	}
	if schedule.matches(time.Date(2026, 1, 5, 9, 15, 29, 0, location)) {
		t.Fatal("cron should not match the wrong second")
	}
	if schedule.matches(time.Date(2026, 2, 5, 9, 15, 30, 0, location)) {
		t.Fatal("cron should not match an unlisted month")
	}
	if schedule.matches(time.Date(2026, 1, 4, 9, 15, 30, 0, location)) {
		t.Fatal("cron should not match an unlisted weekday")
	}
}

func TestValidCronExpressionRejectsOutOfRangeAndMalformedValues(t *testing.T) {
	valid := []string{
		"0 3 * * *",
		"30 0 3 * * *",
		"*/10 1-5/2 * JAN MON-FRI",
	}
	for _, expression := range valid {
		if !validCronExpression(expression) {
			t.Fatalf("validCronExpression(%q) = false, want true", expression)
		}
	}

	invalid := []string{
		"",
		"* * * *",
		"60 * * * * *",
		"0 24 * * *",
		"0 3 0 * *",
		"0 3 * FOO *",
		"0 3 * * FUNDAY",
		"0 3 * * MON-",
	}
	for _, expression := range invalid {
		if validCronExpression(expression) {
			t.Fatalf("validCronExpression(%q) = true, want false", expression)
		}
	}
}

func TestBackupScheduleFromSettingsDisablesInvalidOrDisabledSchedules(t *testing.T) {
	_, signature, enabled, err := backupScheduleFromSettings(databaseBackupSettings{
		Enabled:  false,
		Cron:     "0 3 * * *",
		Timezone: "Asia/Shanghai",
	})
	if err != nil || enabled || signature != "" {
		t.Fatalf("disabled schedule = enabled:%v signature:%q err:%v, want disabled without error", enabled, signature, err)
	}

	_, signature, enabled, err = backupScheduleFromSettings(databaseBackupSettings{
		Enabled:  true,
		Cron:     "0 3 * * *",
		Timezone: "No/Such_Zone",
	})
	if err == nil || enabled || signature != "" {
		t.Fatalf("invalid timezone = enabled:%v signature:%q err:%v, want disabled with error", enabled, signature, err)
	}
}
