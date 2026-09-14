package app

import (
	"net/http"

	"github.com/swzyt/chronoframe/backend/go/internal/platform/httpx"
)

func (a *Application) accessConfigRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.accessConfig(w, r)
	case http.MethodPut:
		a.accessConfigUpdate(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) adminUsersRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.adminUsers(w, r)
	case http.MethodPost:
		a.adminUserCreate(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) adminUserRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPatch:
		a.adminUserUpdate(w, r)
	case http.MethodDelete:
		a.adminUserDelete(w, r)
	default:
		w.Header().Set("Allow", "PATCH, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) albumsRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.publicAlbums(w, r)
	case http.MethodPost:
		a.albumCreate(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) albumRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.albumDetail(w, r)
	case http.MethodPut:
		a.albumUpdate(w, r)
	case http.MethodDelete:
		a.albumDelete(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) photosRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.publicPhotos(w, r)
	case http.MethodPost:
		a.photoCreate(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) photoRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPut:
		a.photoUpdate(w, r)
	case http.MethodDelete:
		a.photoDelete(w, r)
	default:
		w.Header().Set("Allow", "PUT, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) photoAlbumsRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.photoAlbums(w, r)
	case http.MethodPut:
		a.photoAlbumsUpdate(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) photoReactionsRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.photoReactions(w, r)
	case http.MethodPost, http.MethodDelete:
		a.photoReactionMutation(w, r)
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) settingsKeyRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.settingsKey(w, r)
	case http.MethodPut:
		a.settingUpdate(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) storageConfigRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.storageProviders(w, r)
	case http.MethodPost:
		a.storageConfigCreate(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) storageConfigIDRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.storageProvider(w, r)
	case http.MethodPut:
		a.storageConfigUpdate(w, r)
	case http.MethodDelete:
		a.storageConfigDelete(w, r)
	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) uploadSharesRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.uploadShares(w, r)
	case http.MethodPost:
		a.uploadShareCreate(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) uploadShareIDRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPatch:
		a.uploadShareUpdate(w, r)
	case http.MethodDelete:
		a.uploadShareDelete(w, r)
	default:
		w.Header().Set("Allow", "PATCH, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

func (a *Application) authSessionRoute(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.authSession(w, r)
	case http.MethodDelete:
		a.authSessionDelete(w, r)
	default:
		w.Header().Set("Allow", "GET, DELETE")
		httpx.Error(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}
