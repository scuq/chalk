// 129-2: the administrator's run-time switches.
//
//	GET /api/admin/settings   -> the current values, defaults filled in
//	PUT /api/admin/settings   <- a partial body; present keys are written
//
// Both require an admin session. The same loader feeds GET /api/auth/config,
// which is public, so the client learns the switches before sign-in and
// never flashes a figure the administrator has turned off.

package auth

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/scuq/chalk/internal/store"
)

// settingSeasonalDecorations is the instance_settings key for the seasonal
// figure (phase 129). Its value is a JSON boolean; absent means true.
const settingSeasonalDecorations = "seasonal_decorations"

// instanceSettings is the wire shape of GET and the response of PUT: every
// switch, with its default where no row exists.
type instanceSettings struct {
	SeasonalDecorations bool `json:"seasonal_decorations"`
}

// instanceSettingsPatch is the PUT body. Pointer fields so an absent key
// leaves the stored value alone.
type instanceSettingsPatch struct {
	SeasonalDecorations *bool `json:"seasonal_decorations"`
}

func defaultInstanceSettings() instanceSettings {
	return instanceSettings{SeasonalDecorations: true}
}

// loadInstanceSettings reads every switch, filling the default for an absent
// row. A nil store (or one without a pool, as in handler-shape tests) yields
// the defaults with no error.
func loadInstanceSettings(ctx context.Context, st *store.Store) (instanceSettings, error) {
	out := defaultInstanceSettings()
	if st == nil || st.Pool == nil {
		return out, nil
	}
	raw, ok, err := st.GetInstanceSetting(ctx, settingSeasonalDecorations)
	if err != nil {
		return out, err
	}
	if ok {
		var b bool
		if err := json.Unmarshal(raw, &b); err == nil {
			out.SeasonalDecorations = b
		}
	}
	return out, nil
}

func (d *HTTPDeps) handleAdminGetSettings(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		s, err := loadInstanceSettings(r.Context(), d.Store)
		if err != nil {
			d.Logger.Printf("admin/settings/get: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed",
				"could not read settings")
			return
		}
		writeJSON(w, http.StatusOK, s)
	})(w, r)
}

func (d *HTTPDeps) handleAdminPutSettings(w http.ResponseWriter, r *http.Request) {
	RequireAdmin(d.Store, func(w http.ResponseWriter, r *http.Request, su *SessionUser) {
		var patch instanceSettingsPatch
		if err := decodeJSON(r, &patch); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		if patch.SeasonalDecorations != nil {
			v, _ := json.Marshal(*patch.SeasonalDecorations)
			if err := d.Store.SetInstanceSetting(r.Context(), settingSeasonalDecorations, v); err != nil {
				d.Logger.Printf("admin/settings/put: %v", err)
				writeError(w, http.StatusInternalServerError, "write_failed",
					"could not save settings")
				return
			}
		}
		s, err := loadInstanceSettings(r.Context(), d.Store)
		if err != nil {
			d.Logger.Printf("admin/settings/put: reread: %v", err)
			writeError(w, http.StatusInternalServerError, "lookup_failed",
				"could not read settings")
			return
		}
		writeJSON(w, http.StatusOK, s)
	})(w, r)
}
