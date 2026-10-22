package vin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// Entry is a cached decode.
type Entry struct {
	Result    Result
	StaleAt   time.Time
	ExpiresAt time.Time
}

// Cache stores decodes. Implementations return (nil, nil) for a miss.
type Cache interface {
	Get(ctx context.Context, vin string) (*Entry, error)
	GetMany(ctx context.Context, vins []string) (map[string]Entry, error)
	Set(ctx context.Context, e Entry) error
}

// Cache states reported to callers.
const (
	CacheHit   = "hit"
	CacheStale = "stale"
	CacheMiss  = "miss"
)

// Policy is the provider policy from vin-core (createVehicleDataService).
type Policy struct {
	// Timeout bounds each provider attempt.
	Timeout time.Duration
	// Retries is the number of extra attempts for a retryable error, per
	// provider, before falling back to the next one.
	Retries int
	// TTL is how long an entry is served at all; StaleAfter is when it starts
	// being reported as stale.
	TTL        time.Duration
	StaleAfter time.Duration
	// Backoff is the wait before retry n (0-based).
	Backoff func(attempt int) time.Duration
	// BatchLimit and BatchConcurrency bound DecodeBatch.
	BatchLimit       int
	BatchConcurrency int
}

// DefaultPolicy matches the TypeScript service: 4 s timeout, one retry with 100 ms
// exponential backoff, 90-day entries that go stale after 30 days, batches of
// up to 50 decoded five at a time.
var DefaultPolicy = Policy{
	Timeout:          4 * time.Second,
	Retries:          1,
	TTL:              90 * 24 * time.Hour,
	StaleAfter:       30 * 24 * time.Hour,
	Backoff:          func(attempt int) time.Duration { return 100 * time.Millisecond << attempt },
	BatchLimit:       50,
	BatchConcurrency: 5,
}

// Service decodes through the cache, then the providers in order.
type Service struct {
	providers []Provider
	cache     Cache
	policy    Policy
	log       *slog.Logger
	now       func() time.Time
	inflight  singleflight.Group
}

// NewService builds a Service. At least one provider is required.
func NewService(providers []Provider, cache Cache, policy Policy, log *slog.Logger) *Service {
	if len(providers) == 0 {
		panic("vin: at least one provider is required")
	}
	if log == nil {
		log = slog.Default()
	}
	return &Service{providers: providers, cache: cache, policy: policy, log: log, now: time.Now}
}

// Outcome is a decode with its cache state.
type Outcome struct {
	Result    Result
	Cache     string
	Attempted []string
}

// Allow is called before any provider request (a cache miss) and may refuse
// it, e.g. a per-user provider quota.
type Allow func() error

// Decode returns the decode for raw, from the cache when it holds a live
// entry, otherwise from the first provider that answers.
func (s *Service) Decode(ctx context.Context, raw string, allow Allow) (Outcome, error) {
	v := Validate(raw)
	if !v.Valid {
		return Outcome{}, &Error{Code: CodeInvalidVIN, Message: "VIN validation failed"}
	}
	if s.cache != nil {
		entry, err := s.cache.Get(ctx, v.VIN)
		if err != nil {
			// A cache outage degrades to provider calls; it does not fail
			// the decode.
			s.log.Warn("vin cache read failed", "error_kind", errorKind(err))
		} else if out, ok := s.fromEntry(entry); ok {
			return out, nil
		}
	}
	if allow != nil {
		if err := allow(); err != nil {
			return Outcome{}, err
		}
	}
	return s.fetch(ctx, v.VIN)
}

func (s *Service) fromEntry(e *Entry) (Outcome, bool) {
	if e == nil {
		return Outcome{}, false
	}
	now := s.now()
	if !e.ExpiresAt.After(now) {
		return Outcome{}, false
	}
	state := CacheHit
	if !e.StaleAt.After(now) {
		state = CacheStale
	}
	return Outcome{Result: e.Result, Cache: state, Attempted: []string{}}, true
}

// fetch coalesces concurrent requests for one VIN into a single provider
// call. The call is detached from any one caller's cancellation, so a caller
// that gives up does not fail the others waiting on it.
func (s *Service) fetch(ctx context.Context, vin string) (Outcome, error) {
	ch := s.inflight.DoChan(vin, func() (any, error) {
		return s.fromProviders(context.WithoutCancel(ctx), vin)
	})
	select {
	case <-ctx.Done():
		return Outcome{}, &Error{Code: CodeProviderTimeout, Message: "Vehicle decoder timed out", Retryable: true, Cause: ctx.Err()}
	case res := <-ch:
		if res.Err != nil {
			return Outcome{}, res.Err
		}
		return res.Val.(Outcome), nil
	}
}

func (s *Service) fromProviders(ctx context.Context, vin string) (Outcome, error) {
	attempted := make([]string, 0, len(s.providers))
	var last error
	for _, p := range s.providers {
		attempted = append(attempted, p.ID())
		for attempt := 0; attempt <= s.policy.Retries; attempt++ {
			actx, cancel := context.WithTimeout(ctx, s.policy.Timeout)
			result, err := p.Decode(actx, vin)
			cancel()
			if err == nil {
				s.store(ctx, result)
				return Outcome{Result: result, Cache: CacheMiss, Attempted: attempted}, nil
			}
			last = err
			if !IsRetryable(err) || attempt == s.policy.Retries {
				break
			}
			if s.policy.Backoff != nil {
				time.Sleep(s.policy.Backoff(attempt))
			}
		}
		s.log.Info("vin provider failed", "provider", p.ID(), "code", CodeOf(last))
	}
	var e *Error
	if errors.As(last, &e) {
		return Outcome{}, e
	}
	return Outcome{}, &Error{Code: CodeProviderUnavailable, Message: "No vehicle-data provider succeeded", Retryable: true, Cause: last}
}

func (s *Service) store(ctx context.Context, r Result) {
	if s.cache == nil {
		return
	}
	now := s.now()
	err := s.cache.Set(ctx, Entry{Result: r, StaleAt: now.Add(s.policy.StaleAfter), ExpiresAt: now.Add(s.policy.TTL)})
	if err != nil {
		s.log.Warn("vin cache write failed", "error_kind", errorKind(err))
	}
}

// BatchItem is one VIN's outcome in a batch, in request order.
type BatchItem struct {
	VIN     string
	Outcome *Outcome
	Err     error
}

// DecodeBatch decodes up to BatchLimit distinct VINs: one cache read for all
// of them, then provider calls for the misses, BatchConcurrency at a time.
// Duplicates collapse to the first occurrence. One VIN failing does not fail
// the others.
func (s *Service) DecodeBatch(ctx context.Context, raws []string, allow Allow) []BatchItem {
	items := make([]BatchItem, 0, len(raws))
	seen := map[string]bool{}
	var valid []string
	for _, raw := range raws {
		v := Validate(raw)
		if seen[v.VIN] {
			continue
		}
		seen[v.VIN] = true
		item := BatchItem{VIN: v.VIN}
		if !v.Valid {
			item.Err = &Error{Code: CodeInvalidVIN, Message: "VIN validation failed"}
		} else {
			valid = append(valid, v.VIN)
		}
		items = append(items, item)
		if len(items) == s.policy.BatchLimit {
			break
		}
	}

	cached := map[string]Entry{}
	if s.cache != nil && len(valid) > 0 {
		var err error
		if cached, err = s.cache.GetMany(ctx, valid); err != nil {
			s.log.Warn("vin cache read failed", "error_kind", errorKind(err))
			cached = map[string]Entry{}
		}
	}

	sem := make(chan struct{}, max(1, s.policy.BatchConcurrency))
	var wg sync.WaitGroup
	var mu sync.Mutex // serialises allow(), which counts quota
	for i := range items {
		if items[i].Err != nil {
			continue
		}
		if e, ok := cached[items[i].VIN]; ok {
			if out, live := s.fromEntry(&e); live {
				items[i].Outcome = &out
				continue
			}
		}
		if allow != nil {
			mu.Lock()
			err := allow()
			mu.Unlock()
			if err != nil {
				items[i].Err = err
				continue
			}
		}
		wg.Add(1)
		go func(item *BatchItem) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out, err := s.fetch(ctx, item.VIN)
			if err != nil {
				item.Err = err
				return
			}
			item.Outcome = &out
		}(&items[i])
	}
	wg.Wait()
	return items
}

// errorKind names an error's type for logs without logging its message,
// which may echo provider or database details.
func errorKind(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return fmt.Sprintf("%T", err)
}
