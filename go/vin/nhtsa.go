package vin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultNHTSABaseURL is the public vPIC API.
const DefaultNHTSABaseURL = "https://vpic.nhtsa.dot.gov/api/vehicles"

// NHTSAProviderID names the provider in results and provenance.
const NHTSAProviderID = "nhtsa_vpic"

// maxProviderBody bounds a vPIC response. A full extended decode is ~6 KB.
const maxProviderBody = 1 << 20

// NHTSA is the NHTSA vPIC provider (nhtsa.ts).
type NHTSA struct {
	BaseURL string
	Client  *http.Client
	Now     func() time.Time
}

// NewNHTSA returns a provider for baseURL (DefaultNHTSABaseURL if empty).
func NewNHTSA(baseURL string, client *http.Client) *NHTSA {
	if baseURL == "" {
		baseURL = DefaultNHTSABaseURL
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &NHTSA{BaseURL: strings.TrimRight(baseURL, "/"), Client: client, Now: time.Now}
}

// ID implements Provider.
func (n *NHTSA) ID() string { return NHTSAProviderID }

type vpicResponse struct {
	Results []map[string]any `json:"Results"`
}

func (n *NHTSA) fetch(ctx context.Context, path string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.BaseURL+path+"?format=json", nil)
	if err != nil {
		return nil, &Error{Code: CodeProviderUnavailable, Message: "Vehicle decoder is unavailable", Retryable: true, Cause: err}
	}
	req.Header.Set("Accept", "application/json")
	res, err := n.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
			return nil, &Error{Code: CodeProviderTimeout, Message: "Vehicle decoder timed out", Retryable: true, Cause: err}
		}
		return nil, &Error{Code: CodeProviderUnavailable, Message: "Vehicle decoder is unavailable", Retryable: true, Cause: err}
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &Error{
			Code:      CodeProviderRejected,
			Message:   fmt.Sprintf("Vehicle decoder returned HTTP %d", res.StatusCode),
			Retryable: res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests,
		}
	}
	var payload vpicResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, maxProviderBody)).Decode(&payload); err != nil {
		if ctx.Err() != nil {
			return nil, &Error{Code: CodeProviderTimeout, Message: "Vehicle decoder timed out", Retryable: true, Cause: err}
		}
		return nil, &Error{Code: CodeProviderUnavailable, Message: "Vehicle decoder sent an unreadable response", Retryable: true, Cause: err}
	}
	if len(payload.Results) == 0 || payload.Results[0] == nil {
		return nil, &Error{Code: CodeNoVehicleData, Message: "Vehicle decoder returned no result"}
	}
	return payload.Results[0], nil
}

// text is nhtsa.ts text(): blank and "Not Applicable" are null.
func text(row map[string]any, key string) *string {
	v, ok := row[key]
	if !ok || v == nil {
		return nil
	}
	var s string
	switch t := v.(type) {
	case string:
		s = t
	case float64:
		s = strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return nil
	}
	s = strings.TrimSpace(s)
	if s == "" || s == "Not Applicable" {
		return nil
	}
	return &s
}

func number(row map[string]any, key string) *float64 {
	s := text(row, key)
	if s == nil {
		return nil
	}
	f, err := strconv.ParseFloat(*s, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return nil
	}
	return &f
}

func confidenceFor(score int, errorCode *string) string {
	if errorCode != nil && *errorCode != "0" {
		if score >= 70 {
			return "medium"
		}
		return "low"
	}
	switch {
	case score >= 70:
		return "high"
	case score >= 40:
		return "medium"
	default:
		return "low"
	}
}

// Decode implements Provider with DecodeVinValuesExtended.
func (n *NHTSA) Decode(ctx context.Context, raw string) (Result, error) {
	v := Validate(raw)
	if !v.Valid {
		return Result{}, &Error{Code: CodeInvalidVIN, Message: "VIN validation failed"}
	}
	started := n.Now()
	row, err := n.fetch(ctx, "/DecodeVinValuesExtended/"+url.PathEscape(v.VIN))
	if err != nil {
		return Result{}, err
	}
	observed := n.Now()
	observedMs := observed.UnixMilli()

	errorCode := text(row, "ErrorCode")
	warnings := []Warning{}
	if errorCode != nil && *errorCode != "0" {
		msg := "NHTSA returned a decode warning"
		if t := text(row, "ErrorText"); t != nil {
			msg = *t
		}
		warnings = append(warnings, Warning{Code: "NHTSA_" + *errorCode, Message: msg})
	}

	r := Result{
		VIN:                  v.VIN,
		Make:                 text(row, "Make"),
		Model:                text(row, "Model"),
		ModelYear:            number(row, "ModelYear"),
		BodyClass:            text(row, "BodyClass"),
		EngineModel:          text(row, "EngineModel"),
		FuelType:             text(row, "FuelTypePrimary"),
		TransmissionStyle:    text(row, "TransmissionStyle"),
		DriveType:            text(row, "DriveType"),
		VehicleType:          text(row, "VehicleType"),
		Manufacturer:         text(row, "Manufacturer"),
		PlantCountry:         text(row, "PlantCountry"),
		PlantCity:            text(row, "PlantCity"),
		PlantState:           text(row, "PlantState"),
		Trim:                 text(row, "Trim"),
		Series:               text(row, "Series"),
		EngineCylinders:      number(row, "EngineCylinders"),
		EngineDisplacement:   text(row, "DisplacementL"),
		EngineHorsepower:     number(row, "EngineHP"),
		SecondaryFuelType:    text(row, "FuelTypeSecondary"),
		ElectrificationLevel: text(row, "ElectrificationLevel"),
		TransmissionSpeeds:   text(row, "TransmissionSpeeds"),
		Doors:                number(row, "Doors"),
		Seats:                number(row, "Seats"),
		CabType:              text(row, "CabType"),
		BedType:              text(row, "BedType"),
		BedLengthInches:      number(row, "BedLengthIN"),
		ABS:                  text(row, "ABS"),
		AirBagLocations:      text(row, "AirBagLocCurtain"),
		GVWR:                 text(row, "GVWR"),
		SuggestedVIN:         text(row, "SuggestedVIN"),
		ErrorCode:            errorCode,
		ErrorText:            text(row, "ErrorText"),
		PossibleValues:       text(row, "PossibleValues"),
		Provider:             NHTSAProviderID,
		// vPIC does not expose a provider version in this response.
		ProviderVersion: nil,
		DecodedAt:       observedMs,
		DurationMs:      observed.Sub(started).Milliseconds(),
		Warnings:        warnings,
	}

	// completeness: share of the eight core fields that decoded.
	core := []bool{
		r.Make != nil, r.Model != nil, r.ModelYear != nil, r.BodyClass != nil,
		r.EngineModel != nil, r.FuelType != nil, r.TransmissionStyle != nil, r.DriveType != nil,
	}
	filled := 0
	for _, ok := range core {
		if ok {
			filled++
		}
	}
	r.Completeness = int(math.Round(float64(filled) / float64(len(core)) * 100))
	r.Confidence = confidenceFor(r.Completeness, errorCode)

	fields := make([]string, 0, len(row))
	for k := range row {
		if text(row, k) != nil {
			fields = append(fields, k)
		}
	}
	sort.Strings(fields)
	r.Provenance = make([]Provenance, 0, len(fields))
	for _, f := range fields {
		r.Provenance = append(r.Provenance, Provenance{Field: f, Provider: NHTSAProviderID, ObservedAt: observedMs})
	}
	return r, nil
}

// DecodePartial decodes a 3-16 character VIN prefix (DecodeVinValues).
func (n *NHTSA) DecodePartial(ctx context.Context, raw string) (Partial, error) {
	partial, ok := NormalizePartial(raw)
	if !ok {
		return Partial{}, &Error{Code: CodeInvalidVIN, Message: "Partial VIN must contain 3 to 16 valid VIN characters"}
	}
	row, err := n.fetch(ctx, "/DecodeVinValues/"+url.PathEscape(partial))
	if err != nil {
		return Partial{}, err
	}
	return Partial{
		PartialVIN:     partial,
		Make:           text(row, "Make"),
		Manufacturer:   text(row, "Manufacturer"),
		VehicleType:    text(row, "VehicleType"),
		PossibleValues: text(row, "PossibleValues"),
		Provider:       NHTSAProviderID,
		DecodedAt:      n.Now().UnixMilli(),
	}, nil
}
