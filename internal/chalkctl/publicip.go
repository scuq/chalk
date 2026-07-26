package chalkctl

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// coturn needs to be told its own public address: --listening-ip, --relay-ip
// and --external-ip are all pinned explicitly rather than left to the image's
// DETECT_EXTERNAL_IP helper, which guesses and gives no way to check what it
// guessed. The operator can always pass --public-ip; detection is the
// convenience path for the common case of a host with one public IPv4.

// publicIPServices are queried in order until one answers with a valid IPv4.
// Two of them because a failed lookup blocks a deploy, and they are independent
// operators; both return the bare address as text/plain.
var publicIPServices = []string{
	"https://ifconfig.me/ip",
	"https://api.ipify.org",
}

// DetectPublicIP asks an external echo service for this host's public IPv4.
func DetectPublicIP() (string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	var last error
	for _, url := range publicIPServices {
		resp, err := client.Get(url)
		if err != nil {
			last = err
			continue
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
		resp.Body.Close()
		if err != nil {
			last = err
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			last = fmt.Errorf("%s: status %d", url, resp.StatusCode)
			continue
		}
		ip := strings.TrimSpace(string(body))
		if err := ValidatePublicIP(ip); err != nil {
			last = fmt.Errorf("%s: %w", url, err)
			continue
		}
		return ip, nil
	}
	return "", fmt.Errorf("could not detect the public IP (%v) -- pass --public-ip", last)
}

// ValidatePublicIP accepts a bare public IPv4 literal.
//
// IPv6 is rejected on purpose: the relay is pinned to one address family, and
// a coturn told to listen on an IPv6 address while clients offer IPv4
// candidates fails in a way that looks like a firewall problem for hours.
func ValidatePublicIP(s string) error {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil {
		return fmt.Errorf("%q is not an IP address", s)
	}
	if ip.To4() == nil {
		return fmt.Errorf("%q is IPv6; coturn here is configured IPv4-only", s)
	}
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return fmt.Errorf("%q is not a public address -- clients could not reach a relay there", s)
	}
	return nil
}

// ResolvePublicIP returns the configured address, or detects one. Detection
// result is returned so the caller can persist it: a coturn whose relay
// address silently changes between runs is a call-breaking surprise.
func ResolvePublicIP(configured string, logf func(string, ...any)) (string, error) {
	if strings.TrimSpace(configured) != "" {
		if err := ValidatePublicIP(configured); err != nil {
			return "", fmt.Errorf("configured public IP: %w", err)
		}
		return strings.TrimSpace(configured), nil
	}
	ip, err := DetectPublicIP()
	if err != nil {
		return "", err
	}
	if logf != nil {
		logf("detected public IP: %s (pin it with --public-ip if this host is behind NAT)", ip)
	}
	return ip, nil
}
