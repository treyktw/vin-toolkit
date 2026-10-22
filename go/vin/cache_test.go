package vin_test

import (
	"context"
	"testing"
	"time"

	"github.com/treyktw/vin-toolkit/go/vin"
)

// A synthetic VIN no real vehicle uses (valid check digit, all-Z WMI).
const cacheTestVIN = "1ZZZZ00Z9ZZ000000"

// Same flow the Postgres cache test ran against a real database, here against
// MemoryCache: empty read, write, read back, batch read, upsert, sweep.
func TestMemoryCache(t *testing.T) {
	ctx := context.Background()
	if v := vin.Validate(cacheTestVIN); !v.Valid {
		t.Fatalf("test VIN invalid: %+v", v)
	}

	cache := vin.NewMemoryCache()
	if e, err := cache.Get(ctx, cacheTestVIN); err != nil || e != nil {
		t.Fatalf("empty cache: %v %v", e, err)
	}
	make := "TESTMAKE"
	now := time.Now()
	entry := vin.Entry{
		Result:  vin.Result{VIN: cacheTestVIN, Make: &make, Provider: "test", DecodedAt: now.UnixMilli(), Warnings: []vin.Warning{}, Provenance: []vin.Provenance{}},
		StaleAt: now.Add(time.Hour), ExpiresAt: now.Add(2 * time.Hour),
	}
	if err := cache.Set(ctx, entry); err != nil {
		t.Fatal(err)
	}
	got, err := cache.Get(ctx, cacheTestVIN)
	if err != nil || got == nil || *got.Result.Make != "TESTMAKE" {
		t.Fatalf("read back: %+v %v", got, err)
	}
	many, err := cache.GetMany(ctx, []string{cacheTestVIN, "1ZZZZ00Z8NZ000001"})
	if err != nil || len(many) != 1 || many[cacheTestVIN].Result.Provider != "test" {
		t.Fatalf("many: %v %v", many, err)
	}

	// Upsert replaces; an expired entry is swept.
	entry.StaleAt, entry.ExpiresAt = now.Add(-2*time.Hour), now.Add(-time.Hour)
	if err := cache.Set(ctx, entry); err != nil {
		t.Fatal(err)
	}
	if n := cache.SweepExpired(ctx, now, 500); n != 1 {
		t.Fatalf("sweep removed %d", n)
	}
	if got, err := cache.Get(ctx, cacheTestVIN); err != nil || got != nil {
		t.Fatalf("expired entry survived sweep: %+v %v", got, err)
	}
}

// The service never serves an expired entry even before a sweep runs.
func TestServiceIgnoresExpiredBeforeSweep(t *testing.T) {
	ctx := context.Background()
	cache := vin.NewMemoryCache()
	old := "OLD"
	now := time.Now()
	_ = cache.Set(ctx, vin.Entry{
		Result:  vin.Result{VIN: cacheTestVIN, Make: &old, Provider: "cached"},
		StaleAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour),
	})
	fresh := "FRESH"
	provider := providerFunc(func(_ context.Context, v string) (vin.Result, error) {
		return vin.Result{VIN: v, Make: &fresh, Provider: "fresh", Warnings: []vin.Warning{}, Provenance: []vin.Provenance{}}, nil
	})
	s := vin.NewService([]vin.Provider{provider}, cache, vin.DefaultPolicy, nil)
	out, err := s.Decode(ctx, cacheTestVIN, nil)
	if err != nil || out.Cache != vin.CacheMiss || *out.Result.Make != "FRESH" {
		t.Fatalf("expired entry served: %+v %v", out, err)
	}
}

type providerFunc func(ctx context.Context, vin string) (vin.Result, error)

func (providerFunc) ID() string { return "func" }
func (f providerFunc) Decode(ctx context.Context, v string) (vin.Result, error) {
	return f(ctx, v)
}
