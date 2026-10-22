// Package vin decodes vehicle identification numbers.
//
// Ported from the TypeScript vin-core package (vin.ts, nhtsa.ts,
// service.ts). The TypeScript package stays the policy reference; this
// package implements the same contract so both answer alike.
package vin

import (
	"strings"
	"time"
)

var weights = [17]int{8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2}

var transliteration = map[byte]int{
	'A': 1, 'B': 2, 'C': 3, 'D': 4, 'E': 5, 'F': 6, 'G': 7, 'H': 8,
	'J': 1, 'K': 2, 'L': 3, 'M': 4, 'N': 5, 'P': 7, 'R': 9,
	'S': 2, 'T': 3, 'U': 4, 'V': 5, 'W': 6, 'X': 7, 'Y': 8, 'Z': 9,
	'0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
}

const yearCodes = "ABCDEFGHJKLMNPRSTVWXY123456789"

// Normalize upper-cases and strips whitespace and dashes.
func Normalize(raw string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(raw)) {
		if r == '-' || r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func legal(c byte) bool {
	_, ok := transliteration[c]
	return ok
}

// CheckDigit computes the ninth-position check digit, or "" if vin is not
// 17 legal characters.
func CheckDigit(vin string) string {
	v := Normalize(vin)
	if len(v) != 17 {
		return ""
	}
	sum := 0
	for i := range 17 {
		value, ok := transliteration[v[i]]
		if !ok {
			return ""
		}
		sum += value * weights[i]
	}
	r := sum % 11
	if r == 10 {
		return "X"
	}
	return string(rune('0' + r))
}

// Region names the WMI region of the first character.
func Region(vin string) string {
	if vin == "" {
		return "unknown"
	}
	switch c := vin[0]; {
	case c >= '1' && c <= '5':
		return "north_america"
	case c >= 'S' && c <= 'Z':
		return "europe"
	case c >= 'J' && c <= 'R':
		return "asia"
	case c == '6' || c == '7':
		return "oceania"
	case c == '8' || c == '9':
		return "south_america"
	case c >= 'A' && c <= 'H':
		return "africa"
	default:
		return "unknown"
	}
}

// ModelYearCandidates lists the years a tenth-position code can mean.
func ModelYearCandidates(code byte, currentYear int) []int {
	i := strings.IndexByte(yearCodes, code)
	if i < 0 {
		return nil
	}
	var out []int
	for year := 1980 + i; year <= currentYear+31; year += 30 {
		out = append(out, year)
	}
	return out
}

// LikelyModelYear is the latest candidate no later than next year.
func LikelyModelYear(code byte, currentYear int) *int {
	var best *int
	for _, y := range ModelYearCandidates(code, currentYear) {
		if y <= currentYear+1 {
			year := y
			best = &year
		}
	}
	return best
}

// Validation is the outcome of Validate.
type Validation struct {
	Valid bool
	VIN   string
	// Errors holds "length", "characters" or "check_digit".
	Errors          []string
	CheckDigit      string // valid, invalid or not_required
	LikelyModelYear *int
	Region          string
}

// Validate checks length, characters and (for North American WMIs) the
// check digit: the "north_america" policy the TS validateVin defaults to.
func Validate(raw string) Validation {
	return validateAt(raw, time.Now().UTC().Year())
}

func validateAt(raw string, currentYear int) Validation {
	v := Normalize(raw)
	out := Validation{VIN: v, Region: Region(v)}
	if len(v) != 17 {
		out.Errors = append(out.Errors, "length")
	} else {
		for i := range 17 {
			if !legal(v[i]) {
				out.Errors = append(out.Errors, "characters")
				break
			}
		}
	}
	expected := CheckDigit(v)
	required := v != "" && v[0] >= '1' && v[0] <= '5'
	switch {
	case !required:
		out.CheckDigit = "not_required"
	case expected != "" && len(v) >= 9 && v[8:9] == expected:
		out.CheckDigit = "valid"
	default:
		out.CheckDigit = "invalid"
		if len(out.Errors) == 0 {
			out.Errors = append(out.Errors, "check_digit")
		}
	}
	if len(v) >= 10 {
		out.LikelyModelYear = LikelyModelYear(v[9], currentYear)
	}
	out.Valid = len(out.Errors) == 0
	return out
}

// NormalizePartial validates a 3-16 character VIN prefix for partial decode.
func NormalizePartial(raw string) (string, bool) {
	v := Normalize(raw)
	if len(v) < 3 || len(v) > 16 {
		return v, false
	}
	for i := range len(v) {
		if !legal(v[i]) {
			return v, false
		}
	}
	return v, true
}
