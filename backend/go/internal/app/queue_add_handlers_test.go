package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestDecodeQueueAddTaskBodyMatchesNodeZodErrors(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		issues []zodValidationIssue
	}{
		{
			name: "null root",
			body: "null",
			issues: []zodValidationIssue{
				zodInvalidTypeIssue([]any{}, "object", "null"),
			},
		},
		{
			name: "missing payload",
			body: `{}`,
			issues: []zodValidationIssue{
				zodInvalidTypeCodeFirstIssue([]any{"payload"}, "object", "undefined"),
			},
		},
		{
			name: "empty photo storage key",
			body: `{"payload":{"type":"photo","storageKey":""}}`,
			issues: []zodValidationIssue{
				zodTooSmallStringIssue([]any{"payload", "storageKey"}, 1),
			},
		},
		{
			name: "null optionals",
			body: `{"payload":{"type":"photo","storageKey":"x","contentHash":null,"eraseLocation":null},"priority":null,"maxAttempts":null}`,
			issues: []zodValidationIssue{
				zodInvalidTypeIssue([]any{"payload", "contentHash"}, "string", "null"),
				zodInvalidTypeIssue([]any{"payload", "eraseLocation"}, "boolean", "null"),
				zodInvalidTypeIssue([]any{"priority"}, "number", "null"),
				zodInvalidTypeIssue([]any{"maxAttempts"}, "number", "null"),
			},
		},
		{
			name: "reverse geocoding bounds",
			body: `{"payload":{"type":"photo-reverse-geocoding","photoId":"","latitude":-91,"longitude":181}}`,
			issues: []zodValidationIssue{
				zodTooSmallStringIssue([]any{"payload", "photoId"}, 1),
				zodTooSmallNumberIssue([]any{"payload", "latitude"}, -90),
				zodTooBigNumberIssue([]any{"payload", "longitude"}, 180),
			},
		},
		{
			name: "queue number bounds",
			body: `{"payload":{"type":"photo","storageKey":"x"},"priority":-1,"maxAttempts":6}`,
			issues: []zodValidationIssue{
				zodTooSmallNumberIssue([]any{"priority"}, 0),
				zodTooBigNumberIssue([]any{"maxAttempts"}, 5),
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodeQueueAddTaskBody(
				response,
				httptest.NewRequest(http.MethodPost, "/api/queue/add-task", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodeQueueAddTaskBody() ok = true, want false")
			}
			expectAlbumValidationError(t, response, zodValidationMessage(test.issues...))
		})
	}
}

func TestDecodeQueueAddTaskBodyAcceptsFractionalNumbersAndStripsUnknownFields(t *testing.T) {
	hash := strings.Repeat("A", 64)
	response := httptest.NewRecorder()
	body, ok := decodeQueueAddTaskBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/queue/add-task",
			strings.NewReader(`{"payload":{"type":"photo","storageKey":" x ","contentHash":"`+hash+`","eraseLocation":true,"unknown":"drop"},"priority":1.5,"maxAttempts":2.5,"unknown":"drop"}`),
		),
	)
	if !ok {
		t.Fatalf("valid queue task rejected: %s", response.Body.String())
	}
	wantPayload := map[string]any{
		"type":          "photo",
		"storageKey":    " x ",
		"contentHash":   hash,
		"eraseLocation": true,
	}
	if !reflect.DeepEqual(body.Payload, wantPayload) || body.Priority != 1.5 || body.MaxAttempts != 2.5 {
		t.Fatalf("decoded body = %#v, want payload %#v with fractional limits", body, wantPayload)
	}
}

func TestDecodeQueueAddTasksBodyMatchesNodeZodErrors(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		issues []zodValidationIssue
	}{
		{
			name: "missing tasks",
			body: `{}`,
			issues: []zodValidationIssue{
				zodInvalidTypeIssue([]any{"tasks"}, "array", "undefined"),
			},
		},
		{
			name: "empty tasks",
			body: `{"tasks":[]}`,
			issues: []zodValidationIssue{
				zodTooSmallArrayIssue([]any{"tasks"}, 1, "At least one task is required"),
			},
		},
		{
			name: "null task item",
			body: `{"tasks":[null]}`,
			issues: []zodValidationIssue{
				zodInvalidTypeIssue([]any{"tasks", 0}, "object", "null"),
			},
		},
		{
			name: "null nested and default fields",
			body: `{"tasks":[{"payload":null,"priority":null,"maxAttempts":null}],"defaultPriority":null,"defaultMaxAttempts":null}`,
			issues: []zodValidationIssue{
				zodInvalidTypeCodeFirstIssue([]any{"tasks", 0, "payload"}, "object", "null"),
				zodInvalidTypeIssue([]any{"tasks", 0, "priority"}, "number", "null"),
				zodInvalidTypeIssue([]any{"tasks", 0, "maxAttempts"}, "number", "null"),
				zodInvalidTypeIssue([]any{"defaultPriority"}, "number", "null"),
				zodInvalidTypeIssue([]any{"defaultMaxAttempts"}, "number", "null"),
			},
		},
		{
			name: "video discriminator excluded",
			body: `{"tasks":[{"payload":{"type":"video","storageKey":"x"}}]}`,
			issues: []zodValidationIssue{
				zodInvalidDiscriminatorIssue(
					[]any{"tasks", 0, "payload", "type"},
					"type",
					"photo",
					"live-photo-video",
					"photo-reverse-geocoding",
					"photo-erase-location",
				),
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			_, ok := decodeQueueAddTasksBody(
				response,
				httptest.NewRequest(http.MethodPost, "/api/queue/add-tasks", strings.NewReader(test.body)),
			)
			if ok {
				t.Fatal("decodeQueueAddTasksBody() ok = true, want false")
			}
			expectAlbumValidationError(t, response, zodValidationMessage(test.issues...))
		})
	}
}

func TestDecodeQueueAddTasksBodyAppliesFractionalDefaultsAndPerTaskOverrides(t *testing.T) {
	response := httptest.NewRecorder()
	tasks, ok := decodeQueueAddTasksBody(
		response,
		httptest.NewRequest(
			http.MethodPost,
			"/api/queue/add-tasks",
			strings.NewReader(`{
				"tasks":[
					{"payload":{"type":"photo","storageKey":"a","contentHash":"ignored"}},
					{"payload":{"type":"photo-erase-location","photoId":"p"},"priority":8.5,"maxAttempts":4.5}
				],
				"defaultPriority":1.5,
				"defaultMaxAttempts":2.5
			}`),
		),
	)
	if !ok {
		t.Fatalf("valid queue batch rejected: %s", response.Body.String())
	}
	want := []queueTaskInput{
		{
			Payload:     map[string]any{"type": "photo", "storageKey": "a"},
			Priority:    1.5,
			MaxAttempts: 2.5,
		},
		{
			Payload:     map[string]any{"type": "photo-erase-location", "photoId": "p"},
			Priority:    8.5,
			MaxAttempts: 4.5,
		},
	}
	if !reflect.DeepEqual(tasks, want) {
		t.Fatalf("decoded tasks = %#v, want %#v", tasks, want)
	}
}

func TestDecodeQueueAddTasksBodyReportsNodeMaximumArrayIssue(t *testing.T) {
	values := make([]map[string]any, 1001)
	for index := range values {
		values[index] = map[string]any{
			"payload": map[string]any{"type": "photo", "storageKey": "x"},
		}
	}
	encoded, err := json.Marshal(map[string]any{"tasks": values})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	_, ok := decodeQueueAddTasksBody(
		response,
		httptest.NewRequest(http.MethodPost, "/api/queue/add-tasks", strings.NewReader(string(encoded))),
	)
	if ok {
		t.Fatal("decodeQueueAddTasksBody() ok = true, want false")
	}
	expectAlbumValidationError(
		t,
		response,
		zodValidationMessage(zodTooBigArrayIssue(
			[]any{"tasks"},
			1000,
			"Too many tasks: maximum 1000 tasks per batch",
		)),
	)
}
