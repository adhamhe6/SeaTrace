#pragma once

#include <map>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>

#include "core/equipment_types.hpp"

namespace seatrace::sim {

// Raised for any problem in fleet.json (the message names the offending path).
class ConfigError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

using ParamValues = std::map<std::string, double, std::less<>>;

// One tunable number of an equipment model, with its default and accepted range.
struct ParamDef {
  std::string_view key;
  double default_value;
  double min;
  double max;
};

// `rated` values are design/protection values (trip temperature, pump capacity, rated power).
// `parameters` are dynamics tuning (time constants, noise, profile periods).
std::span<const ParamDef> rated_param_defs(EquipmentType type);
std::span<const ParamDef> tuning_param_defs(EquipmentType type);

// The fully resolved parameters of one equipment: defaults overlaid with the configured values.
class ParamSet {
 public:
  // Throws ConfigError for unknown keys, out-of-range values and inconsistent combinations.
  ParamSet(EquipmentType type, const ParamValues& rated, const ParamValues& parameters);

  // Looks a value up by key; throws std::out_of_range for keys that are not defined for the type
  // (a programming error, never a user error).
  double get(std::string_view key) const;

 private:
  ParamValues values_;
};

}  // namespace seatrace::sim
