package handlers

import (
	"context"
	"log"
	"time"
)

// StartRoomReaper starts a periodic background worker that reaps expired rooms
func (h *Handler) StartRoomReaper(interval time.Duration) func() {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})

	go func() {
		for {
			select {
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				count := h.ReapExpiredRooms(ctx)
				cancel()
				if count > 0 {
					log.Printf("[reaper] auto-reaped %d expired screening rooms", count)
				}
			case <-stop:
				ticker.Stop()
				return
			}
		}
	}()

	return func() {
		close(stop)
	}
}

// ReapExpiredRooms finds and shuts down all active rooms whose ExpiresAt has passed
func (h *Handler) ReapExpiredRooms(ctx context.Context) int {
	if h.RoomRepo == nil {
		return 0
	}

	now := time.Now()
	expiredRooms, err := h.RoomRepo.FindExpiredActive(ctx, now)
	if err != nil {
		log.Printf("[reaper] error querying expired rooms: %v", err)
		return 0
	}

	reaped := 0
	for _, room := range expiredRooms {
		if err := h.RoomRepo.Shutdown(ctx, room.RoomCode); err != nil {
			log.Printf("[reaper] failed to shut down expired room %s: %v", room.RoomCode, err)
			continue
		}

		if h.Hub != nil {
			h.Hub.CloseRoom(room.RoomCode, "Screening complete — room has concluded.")
		}
		reaped++
	}

	return reaped
}
