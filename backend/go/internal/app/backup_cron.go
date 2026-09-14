package app

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type backupCronField struct {
	values map[int]bool
}

type backupCronFields struct {
	hasSeconds  bool
	seconds     backupCronField
	minutes     backupCronField
	hours       backupCronField
	daysOfMonth backupCronField
	months      backupCronField
	daysOfWeek  backupCronField
}

type backupCronSchedule struct {
	expression string
	timezone   string
	location   *time.Location
	fields     backupCronFields
}

var backupCronMonthAliases = map[string]int{
	"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
	"JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

var backupCronWeekdayAliases = map[string]int{
	"SUN": 0, "MON": 1, "TUE": 2, "WED": 3, "THU": 4, "FRI": 5, "SAT": 6,
}

func parseBackupCronSchedule(expression, timezone string) (backupCronSchedule, error) {
	locationName := strings.TrimSpace(timezone)
	if locationName == "" {
		locationName = "Asia/Shanghai"
	}
	location, err := time.LoadLocation(locationName)
	if err != nil {
		return backupCronSchedule{}, fmt.Errorf("load backup cron timezone %q: %w", locationName, err)
	}
	fields, err := parseBackupCronFields(expression)
	if err != nil {
		return backupCronSchedule{}, err
	}
	return backupCronSchedule{
		expression: strings.TrimSpace(expression),
		timezone:   locationName,
		location:   location,
		fields:     fields,
	}, nil
}

func parseBackupCronFields(expression string) (backupCronFields, error) {
	parts := strings.Fields(expression)
	if len(parts) != 5 && len(parts) != 6 {
		return backupCronFields{}, fmt.Errorf("backup cron must have 5 or 6 fields")
	}

	var result backupCronFields
	var err error
	offset := 0
	if len(parts) == 6 {
		result.hasSeconds = true
		result.seconds, err = parseBackupCronField(parts[0], 0, 59, nil, nil)
		if err != nil {
			return backupCronFields{}, fmt.Errorf("seconds: %w", err)
		}
		offset = 1
	} else {
		result.seconds = backupCronField{values: map[int]bool{0: true}}
	}
	result.minutes, err = parseBackupCronField(parts[offset], 0, 59, nil, nil)
	if err != nil {
		return backupCronFields{}, fmt.Errorf("minutes: %w", err)
	}
	result.hours, err = parseBackupCronField(parts[offset+1], 0, 23, nil, nil)
	if err != nil {
		return backupCronFields{}, fmt.Errorf("hours: %w", err)
	}
	result.daysOfMonth, err = parseBackupCronField(parts[offset+2], 1, 31, nil, nil)
	if err != nil {
		return backupCronFields{}, fmt.Errorf("day-of-month: %w", err)
	}
	result.months, err = parseBackupCronField(parts[offset+3], 1, 12, backupCronMonthAliases, nil)
	if err != nil {
		return backupCronFields{}, fmt.Errorf("month: %w", err)
	}
	result.daysOfWeek, err = parseBackupCronField(parts[offset+4], 0, 7, backupCronWeekdayAliases, func(value int) int {
		if value == 7 {
			return 0
		}
		return value
	})
	if err != nil {
		return backupCronFields{}, fmt.Errorf("day-of-week: %w", err)
	}
	return result, nil
}

func parseBackupCronField(
	raw string,
	minimum int,
	maximum int,
	aliases map[string]int,
	normalize func(int) int,
) (backupCronField, error) {
	field := backupCronField{values: map[int]bool{}}
	for _, rawToken := range strings.Split(raw, ",") {
		token := strings.TrimSpace(rawToken)
		if token == "" {
			return backupCronField{}, fmt.Errorf("empty token")
		}
		rangePart := token
		step := 1
		hasStep := false
		if left, right, ok := strings.Cut(token, "/"); ok {
			hasStep = true
			if strings.Contains(right, "/") {
				return backupCronField{}, fmt.Errorf("invalid step token %q", token)
			}
			rangePart = left
			parsedStep, err := strconv.Atoi(right)
			if err != nil || parsedStep <= 0 {
				return backupCronField{}, fmt.Errorf("invalid step %q", right)
			}
			step = parsedStep
		}

		start, end, err := parseBackupCronRange(rangePart, minimum, maximum, aliases, hasStep)
		if err != nil {
			return backupCronField{}, err
		}
		for value := start; value <= end; value += step {
			normalized := value
			if normalize != nil {
				normalized = normalize(value)
			}
			field.values[normalized] = true
		}
	}
	if len(field.values) == 0 {
		return backupCronField{}, fmt.Errorf("field has no values")
	}
	return field, nil
}

func parseBackupCronRange(
	rangePart string,
	minimum int,
	maximum int,
	aliases map[string]int,
	hasStep bool,
) (int, int, error) {
	part := strings.TrimSpace(rangePart)
	if part == "" {
		return 0, 0, fmt.Errorf("empty range")
	}
	if part == "*" {
		return minimum, maximum, nil
	}
	if left, right, ok := strings.Cut(part, "-"); ok {
		start, err := parseBackupCronValue(left, minimum, maximum, aliases)
		if err != nil {
			return 0, 0, err
		}
		end, err := parseBackupCronValue(right, minimum, maximum, aliases)
		if err != nil {
			return 0, 0, err
		}
		if start > end {
			return 0, 0, fmt.Errorf("range %q starts after it ends", part)
		}
		return start, end, nil
	}
	value, err := parseBackupCronValue(part, minimum, maximum, aliases)
	if err != nil {
		return 0, 0, err
	}
	if hasStep {
		return value, maximum, nil
	}
	return value, value, nil
}

func parseBackupCronValue(value string, minimum int, maximum int, aliases map[string]int) (int, error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	if aliases != nil {
		if aliasValue, ok := aliases[normalized]; ok {
			return aliasValue, nil
		}
	}
	parsed, err := strconv.Atoi(normalized)
	if err != nil {
		return 0, fmt.Errorf("invalid cron value %q", value)
	}
	if parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("cron value %d out of range %d-%d", parsed, minimum, maximum)
	}
	return parsed, nil
}

func (field backupCronField) contains(value int) bool {
	return field.values[value]
}

func (schedule backupCronSchedule) matches(instant time.Time) bool {
	if schedule.location == nil {
		return false
	}
	local := instant.In(schedule.location)
	return schedule.fields.seconds.contains(local.Second()) &&
		schedule.fields.minutes.contains(local.Minute()) &&
		schedule.fields.hours.contains(local.Hour()) &&
		schedule.fields.daysOfMonth.contains(local.Day()) &&
		schedule.fields.months.contains(int(local.Month())) &&
		schedule.fields.daysOfWeek.contains(int(local.Weekday()))
}

func (schedule backupCronSchedule) matchStamp(instant time.Time) string {
	if schedule.location == nil {
		return ""
	}
	return schedule.expression + "|" + schedule.timezone + "|" + instant.In(schedule.location).Format("2006-01-02T15:04:05")
}

func validCronExpression(value string) bool {
	_, err := parseBackupCronFields(value)
	return err == nil
}
