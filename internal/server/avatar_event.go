package server

// 112-1: the avatar push.
//
// Same shape as the typing push (typing_event.go): a channel-scoped event on
// chalk_global, unwrapped by every instance and fanned out to that channel's
// members. It carries the ids only -- the picture itself is ciphertext the
// receiver fetches and decrypts like any other attachment.
//
// One difference from typing: the originating user is NOT skipped. Their
// other devices have no way to learn about a picture they did not set
// themselves, and the tab that did set it folds the push idempotently on top
// of its own ack.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

// publishAvatarEvent emits the Kind="avatar" event. An empty attachmentID
// means the picture was removed.
func (h *WSHandler) publishAvatarEvent(
	ctx context.Context,
	channelID, userID uuid.UUID,
	attachmentID string,
	keyVersion int,
) error {
	if h.store == nil {
		return errors.New("no store")
	}
	payload, err := json.Marshal(proto.AvatarUpdatePayload{
		ChannelID:    channelID.String(),
		UserID:       userID.String(),
		AttachmentID: attachmentID,
		KeyVersion:   keyVersion,
	})
	if err != nil {
		return err
	}
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		return pubsub.PublishWithTx(ctx, tx, pubsub.Event{
			Kind:                "avatar",
			UserID:              userID,
			ChannelID:           channelID,
			InstanceID:          h.instanceID,
			ChannelEventPayload: payload,
		})
	})
}

// handleAvatarEvent routes one avatar change to the channel's members.
func (s *Server) handleAvatarEvent(ev pubsub.Event) {
	if s.store == nil || ev.ChannelID == uuid.Nil || len(ev.ChannelEventPayload) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	members, err := s.store.ListMembersForChannel(ctx, ev.ChannelID)
	if err != nil {
		s.logger.Printf("avatar event members %s: %v", ev.ChannelID, err)
		return
	}

	var p proto.AvatarUpdatePayload
	if err := json.Unmarshal(ev.ChannelEventPayload, &p); err != nil {
		s.logger.Printf("avatar event payload: %v", err)
		return
	}
	frame, err := proto.NewFrame(proto.TypeAvatarUpdate, "", p)
	if err != nil {
		s.logger.Printf("avatar event frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("avatar event marshal: %v", err)
		return
	}

	for _, m := range members {
		s.hub.FanOutToUser(m.String(), "", wire)
	}
}
