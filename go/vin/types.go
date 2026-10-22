package vin

import (
	"context"
	"errors"
	"fmt"
)

// Result is the vendor-neutral decode contract every client reads
// (vin-core VehicleDecodeResult). Field names and nulls match the
// TypeScript type exactly; the cache stores this JSON.
type Result struct {
	VIN                  string       `json:"vin"`
	Make                 *string      `json:"make"`
	Model                *string      `json:"model"`
	ModelYear            *float64     `json:"modelYear"`
	VehicleType          *string      `json:"vehicleType"`
	Manufacturer         *string      `json:"manufacturer"`
	PlantCountry         *string      `json:"plantCountry"`
	PlantCity            *string      `json:"plantCity"`
	PlantState           *string      `json:"plantState"`
	Trim                 *string      `json:"trim"`
	Series               *string      `json:"series"`
	EngineModel          *string      `json:"engineModel"`
	EngineCylinders      *float64     `json:"engineCylinders"`
	EngineDisplacement   *string      `json:"engineDisplacement"`
	EngineHorsepower     *float64     `json:"engineHorsepower"`
	FuelType             *string      `json:"fuelType"`
	SecondaryFuelType    *string      `json:"secondaryFuelType"`
	ElectrificationLevel *string      `json:"electrificationLevel"`
	TransmissionStyle    *string      `json:"transmissionStyle"`
	TransmissionSpeeds   *string      `json:"transmissionSpeeds"`
	DriveType            *string      `json:"driveType"`
	BodyClass            *string      `json:"bodyClass"`
	Doors                *float64     `json:"doors"`
	Seats                *float64     `json:"seats"`
	CabType              *string      `json:"cabType"`
	BedType              *string      `json:"bedType"`
	BedLengthInches      *float64     `json:"bedLengthInches"`
	ABS                  *string      `json:"abs"`
	AirBagLocations      *string      `json:"airBagLocations"`
	GVWR                 *string      `json:"gvwr"`
	SuggestedVIN         *string      `json:"suggestedVIN"`
	ErrorCode            *string      `json:"errorCode"`
	ErrorText            *string      `json:"errorText"`
	PossibleValues       *string      `json:"possibleValues"`
	Provider             string       `json:"provider"`
	ProviderVersion      *string      `json:"providerVersion"`
	DecodedAt            int64        `json:"decodedAt"`
	DurationMs           int64        `json:"durationMs"`
	Confidence           string       `json:"confidence"`
	Completeness         int          `json:"completeness"`
	Warnings             []Warning    `json:"warnings"`
	Provenance           []Provenance `json:"provenance"`
}

// Warning is a provider decode warning.
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Provenance records which provider supplied a field.
type Provenance struct {
	Field      string `json:"field"`
	Provider   string `json:"provider"`
	ObservedAt int64  `json:"observedAt"`
}

// Partial is a partial-VIN decode for intake suggestions.
type Partial struct {
	PartialVIN     string  `json:"partialVIN"`
	Make           *string `json:"make"`
	Manufacturer   *string `json:"manufacturer"`
	VehicleType    *string `json:"vehicleType"`
	PossibleValues *string `json:"possibleValues"`
	Provider       string  `json:"provider"`
	DecodedAt      int64   `json:"decodedAt"`
}

// Provider decodes VINs from one data source.
type Provider interface {
	ID() string
	Decode(ctx context.Context, vin string) (Result, error)
}

// Error codes (VehicleDataErrorCode).
const (
	CodeInvalidVIN          = "INVALID_VIN"
	CodeProviderTimeout     = "PROVIDER_TIMEOUT"
	CodeProviderRejected    = "PROVIDER_REJECTED"
	CodeProviderUnavailable = "PROVIDER_UNAVAILABLE"
	CodeNoVehicleData       = "NO_VEHICLE_DATA"
)

// Error is a decode failure with a stable code (VehicleDataError).
type Error struct {
	Code      string
	Message   string
	Retryable bool
	Cause     error
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }
func (e *Error) Unwrap() error { return e.Cause }

// IsRetryable reports whether err is a retryable provider error.
func IsRetryable(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Retryable
}

// CodeOf returns err's code, or PROVIDER_UNAVAILABLE.
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return CodeProviderUnavailable
}
