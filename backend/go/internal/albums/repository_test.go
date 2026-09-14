package albums

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestListPublicReturnsVisibleAlbumsWithOwnersAndOrderedPhotoIDs(t *testing.T) {
	database := openAlbumTestDatabase(t)
	defer database.Close()

	repository := NewSQLiteRepository(database)
	albums, err := repository.ListPublic(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(albums) != 2 {
		t.Fatalf("len(albums) = %d, want 2", len(albums))
	}
	if albums[0].ID != 20 || albums[1].ID != 10 {
		t.Fatalf("album order = [%d, %d], want [20, 10]", albums[0].ID, albums[1].ID)
	}
	if albums[0].IsHidden {
		t.Fatal("visible album returned as hidden")
	}
	if albums[0].Owner == nil || albums[0].Owner.Username != "owner" {
		t.Fatalf("owner = %#v, want owner username", albums[0].Owner)
	}
	if !reflect.DeepEqual(albums[0].PhotoIDs, []string{"photo-b", "photo-a"}) {
		t.Fatalf("photo ids = %#v, want ordered ids", albums[0].PhotoIDs)
	}
}

func openAlbumTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "albums.sqlite3")
	database, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, is_admin INTEGER NOT NULL);`,
		`CREATE TABLE albums (
			id INTEGER PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT,
			cover_photo_id TEXT,
			is_hidden INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			owner_user_id INTEGER NOT NULL
		);`,
		`CREATE TABLE album_photos (album_id INTEGER NOT NULL, photo_id TEXT NOT NULL, position REAL NOT NULL);`,
		`INSERT INTO users (id, name, avatar, is_admin) VALUES (1, 'owner', NULL, 0);`,
		`INSERT INTO albums (id, title, description, cover_photo_id, is_hidden, created_at, updated_at, owner_user_id)
		 VALUES (10, 'Older', NULL, NULL, 0, 100, 110, 1);`,
		`INSERT INTO albums (id, title, description, cover_photo_id, is_hidden, created_at, updated_at, owner_user_id)
		 VALUES (20, 'Newer', 'desc', 'photo-a', 0, 200, 210, 1);`,
		`INSERT INTO albums (id, title, description, cover_photo_id, is_hidden, created_at, updated_at, owner_user_id)
		 VALUES (30, 'Hidden', NULL, NULL, 1, 300, 310, 1);`,
		`INSERT INTO album_photos (album_id, photo_id, position) VALUES (20, 'photo-a', 2);`,
		`INSERT INTO album_photos (album_id, photo_id, position) VALUES (20, 'photo-b', 1);`,
	}
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			t.Fatalf("exec fixture: %v", err)
		}
	}
	return database
}
