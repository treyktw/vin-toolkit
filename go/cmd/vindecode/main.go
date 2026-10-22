// Command vindecode validates a VIN and decodes it through NHTSA vPIC using
// the same service (timeouts, retry, coalescing, cache) the API used.
//
//	go run ./cmd/vindecode 1HGBH41JXMN109186
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/treyktw/vin-toolkit/go/vin"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: vindecode <VIN>")
		os.Exit(2)
	}
	v := vin.Validate(os.Args[1])
	if !v.Valid {
		fmt.Fprintf(os.Stderr, "invalid VIN %s: %v (check digit %s)\n", v.VIN, v.Errors, v.CheckDigit)
		os.Exit(1)
	}
	service := vin.NewService([]vin.Provider{vin.NewNHTSA("", nil)}, vin.NewMemoryCache(), vin.DefaultPolicy, nil)
	out, err := service.Decode(context.Background(), v.VIN, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(map[string]any{"cache": out.Cache, "attempted": out.Attempted, "data": out.Result})
}
