package vin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Vectors from packages/vin-core/src/vin.test.ts.
func TestValidate(t *testing.T) {
	v := validateAt(" 1hgbh41jxmn109186 ", 2026)
	if !v.Valid || v.VIN != "1HGBH41JXMN109186" || v.CheckDigit != "valid" || v.Region != "north_america" {
		t.Fatalf("validation = %+v", v)
	}
	if v.LikelyModelYear == nil || *v.LikelyModelYear != 2021 {
		t.Fatalf("likely year = %v", v.LikelyModelYear)
	}
	if CheckDigit(v.VIN) != "X" {
		t.Fatalf("check digit = %q", CheckDigit(v.VIN))
	}
	if got := ModelYearCandidates('M', 2026); len(got) < 2 || got[0] != 1991 || got[1] != 2021 {
		t.Fatalf("candidates = %v", got)
	}

	bad := Validate("1HGBH41JXMN109187")
	if bad.Valid || len(bad.Errors) != 1 || bad.Errors[0] != "check_digit" {
		t.Fatalf("bad check digit = %+v", bad)
	}
	for _, raw := range []string{"INVALID", "1HGBH41JXMN10918", "1HGBH41JXMN1091866", "1HGBH4IJXMN109186"} {
		if Validate(raw).Valid {
			t.Errorf("%q validated", raw)
		}
	}
	// Outside North America the check digit is not required.
	if v := Validate("WZZZZ00Z0ZZ000006"); !v.Valid || v.CheckDigit != "not_required" {
		t.Errorf("european VIN = %+v", v)
	}
	if _, ok := NormalizePartial("1hg-bh"); !ok {
		t.Error("partial rejected")
	}
	if _, ok := NormalizePartial("1H"); ok {
		t.Error("two-character partial accepted")
	}
}

func vpicServer(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) *NHTSA {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(handler))
	t.Cleanup(srv.Close)
	return NewNHTSA(srv.URL, srv.Client())
}

// Mirrors packages/vin-core/src/nhtsa.test.ts.
func TestNHTSAMapsTheContract(t *testing.T) {
	var path string
	p := vpicServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path + "?" + r.URL.RawQuery
		_ = json.NewEncoder(w).Encode(map[string]any{"Results": []map[string]any{{
			"VIN": "1HGBH41JXMN109186", "Make": "HONDA", "Model": "Accord", "ModelYear": "1991",
			"BodyClass": "Sedan/Saloon", "Doors": "4", "FuelTypePrimary": "Gasoline", "Trim": "Not Applicable",
			"ErrorCode": "0", "ErrorText": "0 - VIN decoded clean. Check Digit (9th position) is correct",
		}}})
	})
	r, err := p.Decode(context.Background(), "1HGBH41JXMN109186")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, "/DecodeVinValuesExtended/1HGBH41JXMN109186?format=json") {
		t.Fatalf("path = %s", path)
	}
	if *r.Make != "HONDA" || *r.Model != "Accord" || *r.ModelYear != 1991 || *r.Doors != 4 {
		t.Fatalf("result = %+v", r)
	}
	if r.Provider != NHTSAProviderID || r.ProviderVersion != nil || r.Confidence != "medium" || r.Trim != nil {
		t.Fatalf("result = %+v", r)
	}
	if r.Completeness != 63 || len(r.Warnings) != 0 || len(r.Provenance) == 0 {
		t.Fatalf("completeness %d, warnings %v, provenance %d", r.Completeness, r.Warnings, len(r.Provenance))
	}
	// JSON keys match the TypeScript contract, nulls included.
	raw, _ := json.Marshal(r)
	for _, key := range []string{`"modelYear":1991`, `"trim":null`, `"suggestedVIN":null`, `"airBagLocations":null`, `"warnings":[]`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("JSON lacks %s", key)
		}
	}
}

func TestNHTSAErrors(t *testing.T) {
	calls := 0
	p := vpicServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch {
		case strings.Contains(r.URL.Path, "1ZZZZ00Z6PZ000002"):
			w.WriteHeader(http.StatusServiceUnavailable)
		case strings.Contains(r.URL.Path, "1ZZZZ00Z4RZ000003"):
			w.WriteHeader(http.StatusBadRequest)
		default:
			_, _ = w.Write([]byte(`{"Results":[]}`))
		}
	})
	ctx := context.Background()
	if _, err := p.Decode(ctx, "INVALID"); CodeOf(err) != CodeInvalidVIN || calls != 0 {
		t.Fatalf("invalid: %v after %d calls", err, calls)
	}
	if _, err := p.Decode(ctx, "1ZZZZ00Z6PZ000002"); CodeOf(err) != CodeProviderRejected || !IsRetryable(err) {
		t.Fatalf("503: %v", err)
	}
	if _, err := p.Decode(ctx, "1ZZZZ00Z4RZ000003"); CodeOf(err) != CodeProviderRejected || IsRetryable(err) {
		t.Fatalf("400: %v", err)
	}
	if _, err := p.Decode(ctx, "1ZZZZ00Z8NZ000001"); CodeOf(err) != CodeNoVehicleData {
		t.Fatalf("empty: %v", err)
	}
}

type fakeProvider struct {
	id    string
	calls atomic.Int32
	fn    func(n int32, vin string) (Result, error)
}

func (f *fakeProvider) ID() string { return f.id }
func (f *fakeProvider) Decode(_ context.Context, vin string) (Result, error) {
	return f.fn(f.calls.Add(1), vin)
}

func ok(provider string) func(int32, string) (Result, error) {
	return func(_ int32, vin string) (Result, error) {
		make := "HONDA"
		return Result{VIN: vin, Make: &make, Provider: provider, Warnings: []Warning{}, Provenance: []Provenance{}}, nil
	}
}

func testPolicy() Policy {
	p := DefaultPolicy
	p.Backoff = func(int) time.Duration { return 0 }
	return p
}

const goodVIN = "1HGBH41JXMN109186"

// Mirrors packages/vin-core/src/service.test.ts.
func TestServiceCoalescesAndCaches(t *testing.T) {
	release := make(chan struct{})
	p := &fakeProvider{id: "test", fn: func(n int32, vin string) (Result, error) {
		<-release
		return ok("test")(n, vin)
	}}
	s := NewService([]Provider{p}, NewMemoryCache(), testPolicy(), nil)

	var wg sync.WaitGroup
	outs := make([]Outcome, 2)
	for i := range outs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := s.Decode(context.Background(), goodVIN, nil)
			if err != nil {
				t.Error(err)
			}
			outs[i] = out
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if p.calls.Load() != 1 {
		t.Fatalf("provider called %d times", p.calls.Load())
	}
	if outs[0].Cache != CacheMiss || *outs[1].Result.Make != "HONDA" {
		t.Fatalf("outcomes = %+v", outs)
	}
	again, err := s.Decode(context.Background(), goodVIN, nil)
	if err != nil || again.Cache != CacheHit || p.calls.Load() != 1 {
		t.Fatalf("second decode: %+v, %v, calls %d", again, err, p.calls.Load())
	}
}

func TestServiceRejectsInvalidBeforeProviders(t *testing.T) {
	p := &fakeProvider{id: "test", fn: ok("test")}
	s := NewService([]Provider{p}, nil, testPolicy(), nil)
	if _, err := s.Decode(context.Background(), "not-a-vin", nil); CodeOf(err) != CodeInvalidVIN {
		t.Fatal(err)
	}
	if p.calls.Load() != 0 {
		t.Fatal("provider called for an invalid VIN")
	}
}

func TestServiceRetriesThenFallsBack(t *testing.T) {
	flaky := &fakeProvider{id: "flaky", fn: func(int32, string) (Result, error) {
		return Result{}, &Error{Code: CodeProviderTimeout, Message: "slow", Retryable: true}
	}}
	backup := &fakeProvider{id: "backup", fn: ok("backup")}
	s := NewService([]Provider{flaky, backup}, nil, testPolicy(), nil)
	out, err := s.Decode(context.Background(), goodVIN, nil)
	if err != nil {
		t.Fatal(err)
	}
	if flaky.calls.Load() != 2 || backup.calls.Load() != 1 {
		t.Fatalf("calls: flaky %d, backup %d", flaky.calls.Load(), backup.calls.Load())
	}
	if out.Result.Provider != "backup" || len(out.Attempted) != 2 {
		t.Fatalf("outcome = %+v", out)
	}
}

func TestServiceDoesNotRetryPermanentErrors(t *testing.T) {
	gone := &fakeProvider{id: "gone", fn: func(int32, string) (Result, error) {
		return Result{}, &Error{Code: CodeNoVehicleData, Message: "none"}
	}}
	s := NewService([]Provider{gone}, nil, testPolicy(), nil)
	_, err := s.Decode(context.Background(), goodVIN, nil)
	if CodeOf(err) != CodeNoVehicleData || gone.calls.Load() != 1 {
		t.Fatalf("err %v after %d calls", err, gone.calls.Load())
	}
}

func TestServiceStaleAndExpired(t *testing.T) {
	cache := NewMemoryCache()
	p := &fakeProvider{id: "test", fn: ok("fresh")}
	s := NewService([]Provider{p}, cache, testPolicy(), nil)
	now := time.Now()
	make := "OLD"
	_ = cache.Set(context.Background(), Entry{
		Result:  Result{VIN: goodVIN, Make: &make, Provider: "cached"},
		StaleAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour),
	})
	out, err := s.Decode(context.Background(), goodVIN, nil)
	if err != nil || out.Cache != CacheStale || *out.Result.Make != "OLD" || p.calls.Load() != 0 {
		t.Fatalf("stale: %+v %v", out, err)
	}
	_ = cache.Set(context.Background(), Entry{
		Result:  Result{VIN: goodVIN, Make: &make, Provider: "cached"},
		StaleAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour),
	})
	out, err = s.Decode(context.Background(), goodVIN, nil)
	if err != nil || out.Cache != CacheMiss || out.Result.Provider != "fresh" {
		t.Fatalf("expired: %+v %v", out, err)
	}
}

func TestServiceQuotaOnlyOnMisses(t *testing.T) {
	p := &fakeProvider{id: "test", fn: ok("test")}
	s := NewService([]Provider{p}, NewMemoryCache(), testPolicy(), nil)
	denied := errors.New("quota")
	calls := 0
	allow := func() error {
		calls++
		if calls > 1 {
			return denied
		}
		return nil
	}
	if _, err := s.Decode(context.Background(), goodVIN, allow); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Decode(context.Background(), goodVIN, allow); err != nil {
		t.Fatalf("a cache hit consumed quota: %v", err)
	}
	if _, err := s.Decode(context.Background(), "1ZZZZ00Z8NZ000001", allow); !errors.Is(err, denied) {
		t.Fatalf("quota not enforced: %v", err)
	}
}

func TestDecodeBatch(t *testing.T) {
	cache := NewMemoryCache()
	p := &fakeProvider{id: "test", fn: func(n int32, vin string) (Result, error) {
		if vin == "1ZZZZ00Z6PZ000002" {
			return Result{}, &Error{Code: CodeNoVehicleData, Message: "none"}
		}
		return ok("test")(n, vin)
	}}
	s := NewService([]Provider{p}, cache, testPolicy(), nil)
	cached := "CACHED"
	_ = cache.Set(context.Background(), Entry{
		Result:  Result{VIN: "1ZZZZ00Z8NZ000001", Make: &cached},
		StaleAt: time.Now().Add(time.Hour), ExpiresAt: time.Now().Add(2 * time.Hour),
	})
	items := s.DecodeBatch(context.Background(), []string{
		goodVIN, "1hgbh41jxmn109186", "1ZZZZ00Z8NZ000001", "1ZZZZ00Z6PZ000002", "BAD",
	}, nil)
	if len(items) != 4 {
		t.Fatalf("items = %d (duplicates should collapse)", len(items))
	}
	if items[0].Outcome == nil || items[0].Outcome.Cache != CacheMiss {
		t.Errorf("item 0 = %+v", items[0])
	}
	if items[1].Outcome == nil || items[1].Outcome.Cache != CacheHit || *items[1].Outcome.Result.Make != "CACHED" {
		t.Errorf("item 1 = %+v", items[1])
	}
	if CodeOf(items[2].Err) != CodeNoVehicleData || CodeOf(items[3].Err) != CodeInvalidVIN {
		t.Errorf("errors = %v, %v", items[2].Err, items[3].Err)
	}
	if p.calls.Load() != 2 {
		t.Errorf("provider calls = %d", p.calls.Load())
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter(2, time.Hour)
	now := time.Now()
	l.now = func() time.Time { return now }
	if ok, _ := l.Take("u"); !ok {
		t.Fatal("first denied")
	}
	if ok, _ := l.Take("u"); !ok {
		t.Fatal("second denied")
	}
	if ok, retry := l.Take("u"); ok || retry < 3599 {
		t.Fatalf("third allowed=%v retry=%d", ok, retry)
	}
	if ok, _ := l.Take("other"); !ok {
		t.Fatal("keys share a window")
	}
	now = now.Add(time.Hour)
	if ok, _ := l.Take("u"); !ok {
		t.Fatal("window did not reset")
	}
}
