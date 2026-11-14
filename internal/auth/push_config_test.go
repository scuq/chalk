package auth

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// 65-3: /api/auth/config reports only if push is on. The VAPID key will
// travel over the sealed WebSocket, never over plain HTTP.
func TestConfigReportsPushOnly(t *testing.T) {
	b, err := json.Marshal(configResponse{PushEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["push_enabled"] != true {
		t.Fatalf("push_enabled missing: %s", b)
	}
	rt := reflect.TypeOf(configResponse{})
	for i := 0; i < rt.NumField(); i++ {
		f := rt.Field(i)
		name := strings.ToLower(f.Name + " " + f.Tag.Get("json"))
		if strings.Contains(name, "vapid") || strings.Contains(name, "push_key") || strings.Contains(name, "pushkey") {
			t.Fatalf("configResponse.%s carries push key material over plain HTTP", f.Name)
		}
	}
}
