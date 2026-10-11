#pragma once

#include <string>

namespace seatrace::sim {

// Data quality of a published reading. The OPC UA layer maps this onto status codes.
enum class Quality { kGood, kUncertain, kBadSensorFailure };

// Static description of one measurement as configured in fleet.json. The ranges are illustrative
// simulation parameters, not authoritative operating limits.
struct MeasurementSpec {
  std::string name;  // OPC UA BrowseName, e.g. "Temperature"
  std::string key;   // lower_snake_case form used by the backend, e.g. "power_output"
  std::string unit;
  double nominal_min = 0.0;
  double nominal_max = 0.0;
  double plausible_min = 0.0;  // physical limits of the quantity (sensor range)
  double plausible_max = 0.0;
  double noise_sigma = 0.0;  // standard deviation of the sensor noise, in `unit`

  double nominal_mid() const { return 0.5 * (nominal_min + nominal_max); }
  double nominal_half_range() const { return 0.5 * (nominal_max - nominal_min); }
};

struct Reading {
  double value = 0.0;
  Quality quality = Quality::kGood;
};

}  // namespace seatrace::sim
