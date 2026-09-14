package app

import (
	"context"
	"encoding/json"
	"testing"
)

func TestEmptyLivePhotoScanResultMatchesNodeContract(t *testing.T) {
	encoded, err := json.Marshal(emptyLivePhotoScanResult())
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(encoded), `{"processed":0,"matched":0,"errors":[]}`; got != want {
		t.Fatalf("scan result = %s, want %s", got, want)
	}
}

func TestFindPhotoForLiveVideoUsesNodeCandidatePriority(t *testing.T) {
	database := newReadyAppTestDatabase(t)
	if _, err := database.SQL().Exec(`
		INSERT INTO users(id, name, email, password, created_at, is_admin, is_active, auth_version)
		VALUES(81001, 'live-priority-owner', 'live-priority@example.test', NULL, 1, 1, 1, 1);
		INSERT INTO photos(id, media_type, storage_key, owner_user_id)
		VALUES
			('lower-priority-jpg', 'image', 'camera/IMG_0001.jpg', 81001),
			('higher-priority-heic', 'image', 'camera/IMG_0001.HEIC', 81001);
	`); err != nil {
		t.Fatal(err)
	}
	application := NewApplication(Dependencies{Database: database})
	got, found := application.findPhotoForLiveVideo(context.Background(), "camera/IMG_0001.MOV")
	if !found || got != "higher-priority-heic" {
		t.Fatalf("findPhotoForLiveVideo() = (%q,%t), want higher-priority-heic", got, found)
	}
}
