package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	virtualwebauthn "github.com/descope/virtualwebauthn"
)

// 128-3: Test for the policy on unsolicited extension outputs.
//
// go-webauthn v0.18 rejects by default a client extension output that
// the relying party did not request. chalk requests no extension, but
// a third-party passkey provider can return an output such as
// credProps unprompted. The service sets
// ExtensionsUnsolicitedOutputPolicy to ignore, so that the user can
// still register and sign in. Without that setting, the test failed
// with status 400.
//
// Requires CHALK_TEST_DATABASE_URL like the other end-to-end tests.

// TestUnsolicitedExtensionOutputIsIgnored registers a passkey and then
// signs in with it. Both responses carry an unrequested credProps
// output. Both ceremonies must succeed.
func TestUnsolicitedExtensionOutputIsIgnored(t *testing.T) {
	pool, st := openFlagsTestDB(t)
	const username = "extoutputtestuser"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cleanupUser(t, ctx, pool, username)

	srv, rp, client := startFlagsTestServer(t, st)
	vAuth := virtualwebauthn.NewAuthenticator()
	vCred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	registerWithUnsolicitedOutput(t, client, srv.URL, rp, vAuth, vCred, username)
	vAuth.AddCredential(vCred)
	loginWithUnsolicitedOutput(t, client, srv.URL, rp, vAuth, vCred, username)
}

// addUnsolicitedOutput returns the credential response raw with an
// unrequested credProps output in clientExtensionResults.
func addUnsolicitedOutput(t *testing.T, raw string) json.RawMessage {
	t.Helper()
	var cred map[string]any
	if err := json.Unmarshal([]byte(raw), &cred); err != nil {
		t.Fatalf("unmarshal credential response: %v", err)
	}
	cred["clientExtensionResults"] = map[string]any{
		"credProps": map[string]any{"rk": true},
	}
	out, err := json.Marshal(cred)
	if err != nil {
		t.Fatalf("marshal credential response: %v", err)
	}
	return out
}

// registerWithUnsolicitedOutput registers the credential vCred for
// username. The finish request carries the unrequested output. The
// helper fails the test if the server does not accept the registration.
func registerWithUnsolicitedOutput(t *testing.T, client *http.Client, baseURL string,
	rp virtualwebauthn.RelyingParty, vAuth virtualwebauthn.Authenticator,
	vCred virtualwebauthn.Credential, username string) {
	t.Helper()
	beginBody, _ := json.Marshal(map[string]any{
		"username":     username,
		"display_name": "Extension Output Test User",
		"email":        username + "@example.invalid",
	})
	beginResp, err := client.Post(baseURL+"/api/auth/register/begin",
		"application/json", bytes.NewReader(beginBody))
	if err != nil {
		t.Fatalf("register/begin POST: %v", err)
	}
	defer beginResp.Body.Close()
	if beginResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(beginResp.Body)
		t.Fatalf("register/begin status = %d (%s: %s)",
			beginResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var beginOut struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.NewDecoder(beginResp.Body).Decode(&beginOut); err != nil {
		t.Fatalf("decode register/begin: %v", err)
	}
	parsedOpts, err := virtualwebauthn.ParseAttestationOptions(string(beginOut.Options))
	if err != nil {
		t.Fatalf("ParseAttestationOptions: %v", err)
	}
	attResp := virtualwebauthn.CreateAttestationResponse(rp, vAuth, vCred, *parsedOpts)

	finishBody, _ := json.Marshal(map[string]any{
		"credential": addUnsolicitedOutput(t, attResp),
	})
	finishResp, err := client.Post(baseURL+"/api/auth/register/finish",
		"application/json", bytes.NewReader(finishBody))
	if err != nil {
		t.Fatalf("register/finish POST: %v", err)
	}
	defer finishResp.Body.Close()
	if finishResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(finishResp.Body)
		t.Fatalf("register/finish status = %d (%s: %s)",
			finishResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
}

// loginWithUnsolicitedOutput signs in as username with the credential
// vCred. The finish request carries the unrequested output. The helper
// fails the test if the server does not accept the sign-in.
func loginWithUnsolicitedOutput(t *testing.T, client *http.Client, baseURL string,
	rp virtualwebauthn.RelyingParty, vAuth virtualwebauthn.Authenticator,
	vCred virtualwebauthn.Credential, username string) {
	t.Helper()
	beginBody, _ := json.Marshal(map[string]any{"username": username})
	beginResp, err := client.Post(baseURL+"/api/auth/authenticate/begin",
		"application/json", bytes.NewReader(beginBody))
	if err != nil {
		t.Fatalf("authenticate/begin POST: %v", err)
	}
	defer beginResp.Body.Close()
	if beginResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(beginResp.Body)
		t.Fatalf("authenticate/begin status = %d (%s: %s)",
			beginResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
	var beginOut struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.NewDecoder(beginResp.Body).Decode(&beginOut); err != nil {
		t.Fatalf("decode authenticate/begin: %v", err)
	}
	parsedAssertion, err := virtualwebauthn.ParseAssertionOptions(string(beginOut.Options))
	if err != nil {
		t.Fatalf("ParseAssertionOptions: %v", err)
	}
	assertionResp := virtualwebauthn.CreateAssertionResponse(rp, vAuth, vCred, *parsedAssertion)

	finishBody, _ := json.Marshal(map[string]any{
		"credential": addUnsolicitedOutput(t, assertionResp),
	})
	finishResp, err := client.Post(baseURL+"/api/auth/authenticate/finish",
		"application/json", bytes.NewReader(finishBody))
	if err != nil {
		t.Fatalf("authenticate/finish POST: %v", err)
	}
	defer finishResp.Body.Close()
	if finishResp.StatusCode != http.StatusOK {
		eb, _ := decodeError(finishResp.Body)
		t.Fatalf("authenticate/finish status = %d (%s: %s)",
			finishResp.StatusCode, eb.Error.Code, eb.Error.Message)
	}
}
