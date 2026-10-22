package vin

import (
	"sync"
	"time"
)

// Limiter caps provider calls per key in a fixed window (production used
// 60 an hour per user for "vin_decode_provider").
//
// It is process-local: correct for a single instance, and meant to be
// swapped for a shared (e.g. Redis-backed) limiter when the API scales out.
type Limiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	windows map[string]*window
}

type window struct {
	start time.Time
	count int
}

// NewLimiter allows limit calls per key per window.
func NewLimiter(limit int, per time.Duration) *Limiter {
	return &Limiter{limit: limit, window: per, now: time.Now, windows: map[string]*window{}}
}

// Take consumes one call for key. When the window is full it returns false
// and the seconds until it resets.
func (l *Limiter) Take(key string) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	w, ok := l.windows[key]
	if !ok || now.Sub(w.start) >= l.window {
		if len(l.windows) > 10_000 {
			l.prune(now)
		}
		w = &window{start: now}
		l.windows[key] = w
	}
	if w.count >= l.limit {
		retry := int(w.start.Add(l.window).Sub(now).Seconds()) + 1
		return false, retry
	}
	w.count++
	return true, 0
}

func (l *Limiter) prune(now time.Time) {
	for k, w := range l.windows {
		if now.Sub(w.start) >= l.window {
			delete(l.windows, k)
		}
	}
}
