package vin

import (
	"context"
	"sync"
	"time"
)

// The production service kept decodes in a shared Postgres table, on the
// platform path: a decode is shared by every tenant, so no tenant login may
// write it. That adapter depended on the product's schema and generated
// queries, so this showcase ships only the Cache interface (service.go) and
// the in-process implementation below. A database-backed cache implements the
// same three methods; SweepExpired is the background-cleanup hook it also had.

// MemoryCache is an in-process Cache, safe for concurrent use.
type MemoryCache struct {
	mu      sync.Mutex
	entries map[string]Entry
}

// NewMemoryCache returns an empty MemoryCache.
func NewMemoryCache() *MemoryCache {
	return &MemoryCache{entries: map[string]Entry{}}
}

func (m *MemoryCache) lock()   { m.mu.Lock() }
func (m *MemoryCache) unlock() { m.mu.Unlock() }

// Get implements Cache.
func (m *MemoryCache) Get(_ context.Context, vin string) (*Entry, error) {
	m.lock()
	defer m.unlock()
	if e, ok := m.entries[vin]; ok {
		return &e, nil
	}
	return nil, nil
}

// GetMany implements Cache.
func (m *MemoryCache) GetMany(_ context.Context, vins []string) (map[string]Entry, error) {
	m.lock()
	defer m.unlock()
	out := map[string]Entry{}
	for _, v := range vins {
		if e, ok := m.entries[v]; ok {
			out[v] = e
		}
	}
	return out, nil
}

// Set implements Cache.
func (m *MemoryCache) Set(_ context.Context, e Entry) error {
	m.lock()
	defer m.unlock()
	m.entries[e.Result.VIN] = e
	return nil
}

// SweepExpired deletes expired entries, at most batch per call, and reports
// how many it removed.
func (m *MemoryCache) SweepExpired(_ context.Context, now time.Time, batch int) int {
	m.lock()
	defer m.unlock()
	removed := 0
	for vin, e := range m.entries {
		if removed >= batch {
			break
		}
		if !e.ExpiresAt.After(now) {
			delete(m.entries, vin)
			removed++
		}
	}
	return removed
}
