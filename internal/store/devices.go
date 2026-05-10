package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// DeviceType is one of the values allowed by the devices_type_valid CHECK.
type DeviceType string

const (
	DevicePhone          DeviceType = "phone"
	DeviceTablet         DeviceType = "tablet"
	DeviceDesktop        DeviceType = "desktop"
	DeviceBrowserUnknown DeviceType = "browser-unknown"
)

// Valid reports whether the value is one of the recognized device types.
func (d DeviceType) Valid() bool {
	switch d {
	case DevicePhone, DeviceTablet, DeviceDesktop, DeviceBrowserUnknown:
		return true
	}
	return false
}

// Device is one browser/device tied to a user. A user with three browsers
// has three devices; each gets its own MLS identity in phase 10.
type Device struct {
	ID          uuid.UUID
	UserID      uuid.UUID
	Type        DeviceType
	Label       string // user-provided, optional ("Work laptop")
	IdentityKey []byte // MLS signature pubkey, populated in phase 10
	CreatedAt   time.Time
	LastSeen    time.Time
}

// CreateDevice registers a device for a user.
func (s *Store) CreateDevice(ctx context.Context, userID uuid.UUID, dtype DeviceType, label string) (Device, error) {
	if !dtype.Valid() {
		return Device{}, fmt.Errorf("invalid device type: %q", dtype)
	}
	var d Device
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO devices (user_id, device_type, device_label)
		   VALUES ($1, $2, NULLIF($3, ''))
		   RETURNING id, user_id, device_type, COALESCE(device_label, ''),
		             COALESCE(identity_key, ''::bytea), created_at, last_seen`,
		userID, string(dtype), label,
	).Scan(&d.ID, &d.UserID, (*string)(&d.Type), &d.Label, &d.IdentityKey, &d.CreatedAt, &d.LastSeen)
	if err != nil {
		return Device{}, fmt.Errorf("create device: %w", err)
	}
	return d, nil
}

// GetDevice fetches a device by ID.
func (s *Store) GetDevice(ctx context.Context, id uuid.UUID) (Device, error) {
	var d Device
	err := s.Pool.QueryRow(ctx,
		`SELECT id, user_id, device_type, COALESCE(device_label, ''),
		        COALESCE(identity_key, ''::bytea), created_at, last_seen
		   FROM devices WHERE id = $1`, id,
	).Scan(&d.ID, &d.UserID, (*string)(&d.Type), &d.Label, &d.IdentityKey, &d.CreatedAt, &d.LastSeen)
	return d, translateErr(err)
}

// ListDevicesForUser returns all devices for a user, ordered by created_at.
func (s *Store) ListDevicesForUser(ctx context.Context, userID uuid.UUID) ([]Device, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id, user_id, device_type, COALESCE(device_label, ''),
		        COALESCE(identity_key, ''::bytea), created_at, last_seen
		   FROM devices WHERE user_id = $1 ORDER BY created_at ASC`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.UserID, (*string)(&d.Type), &d.Label, &d.IdentityKey, &d.CreatedAt, &d.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// TouchDevice updates last_seen to now(). Called on each successful WS frame
// in later phases. Cheap; covered by the devices_last_seen_idx index.
func (s *Store) TouchDevice(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx, `UPDATE devices SET last_seen = now() WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("touch device: %w", err)
	}
	return nil
}

// DeleteDevice removes a device. Used when a user removes a device from
// their settings. ON DELETE CASCADE on later tables (channel_members,
// device_presence, ...) handles the cleanup.
func (s *Store) DeleteDevice(ctx context.Context, id uuid.UUID) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM devices WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete device: %w", err)
	}
	return nil
}
