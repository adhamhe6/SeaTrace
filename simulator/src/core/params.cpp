#include "core/params.hpp"

#include <array>
#include <cmath>
#include <sstream>

namespace seatrace::sim {

namespace {

constexpr std::array<ParamDef, 1> kEngineRated{{
    {"trip_temperature_c", 118.0, 90.0, 200.0},
}};
constexpr std::array<ParamDef, 11> kEngineTuning{{
    {"trip_delay_s", 5.0, 0.0, 600.0},
    {"start_duration_s", 15.0, 1.0, 600.0},
    {"restart_temperature_c", 95.0, 30.0, 150.0},
    {"thermal_tau_s", 30.0, 1.0, 3600.0},
    {"cooldown_tau_s", 120.0, 1.0, 7200.0},
    {"rpm_tau_s", 8.0, 0.5, 600.0},
    {"load_tau_s", 6.0, 0.5, 600.0},
    {"ambient_c", 35.0, -20.0, 60.0},
    {"load_period_s", 600.0, 10.0, 86400.0},
    {"load_phase_rad", 0.0, -7.0, 7.0},
    {"load_noise_pct", 1.0, 0.0, 10.0},
}};

constexpr std::array<ParamDef, 2> kGeneratorRated{{
    {"power_kw", 625.0, 1.0, 100000.0},
    {"frequency_hz", 50.0, 40.0, 70.0},
}};
constexpr std::array<ParamDef, 8> kGeneratorTuning{{
    {"start_duration_s", 10.0, 1.0, 600.0},
    {"demand_period_s", 900.0, 10.0, 86400.0},
    {"demand_phase_rad", 0.0, -7.0, 7.0},
    {"demand_noise_pct", 1.2, 0.0, 10.0},
    {"droop_hz", 0.6, 0.0, 5.0},
    {"load_tau_s", 4.0, 0.5, 600.0},
    {"frequency_tau_s", 3.0, 0.5, 600.0},
    {"overload_margin_pct", 10.0, 0.0, 50.0},
}};

constexpr std::array<ParamDef, 1> kCoolingRated{{
    {"pressure_bar", 2.6, 0.5, 20.0},
}};
constexpr std::array<ParamDef, 8> kCoolingTuning{{
    {"pressure_tau_s", 6.0, 0.5, 600.0},
    {"temperature_tau_s", 25.0, 1.0, 3600.0},
    {"sea_temperature_c", 28.0, -2.0, 40.0},
    {"engine_coupling", 0.67, 0.0, 1.0},
    {"degraded_pressure_bar", 1.8, 0.1, 20.0},
    {"degraded_temperature_margin_c", 5.0, 0.0, 50.0},
    {"pressure_wobble_bar", 0.04, 0.0, 1.0},
    {"wobble_period_s", 240.0, 10.0, 86400.0},
}};

constexpr std::array<ParamDef, 3> kBilgeRated{{
    {"pump_capacity_cm_per_s", 0.8, 0.01, 10.0},
    {"pump_start_level_cm", 35.0, 1.0, 200.0},
    {"pump_stop_level_cm", 12.0, 0.0, 199.0},
}};
constexpr std::array<ParamDef, 6> kBilgeTuning{{
    {"baseline_level_cm", 9.0, 0.0, 100.0},
    {"relaxation_s", 240.0, 1.0, 86400.0},
    {"inflow_sigma_cm_per_s", 0.18, 0.0, 5.0},
    {"flood_ingress_cm_per_s", 2.0, 0.0, 20.0},
    {"degraded_level_cm", 50.0, 1.0, 500.0},
    {"max_level_cm", 120.0, 10.0, 1000.0},
}};

const ParamDef* find_def(std::span<const ParamDef> defs, std::string_view key) {
  for (const ParamDef& def : defs) {
    if (def.key == key) return &def;
  }
  return nullptr;
}

std::string allowed_keys(std::span<const ParamDef> defs) {
  std::ostringstream out;
  const char* separator = "";
  for (const ParamDef& def : defs) {
    out << separator << def.key;
    separator = ", ";
  }
  return out.str();
}

void overlay(const ParamValues& configured, std::span<const ParamDef> defs, std::string_view group,
             ParamValues& out) {
  for (const auto& [key, value] : configured) {
    const ParamDef* def = find_def(defs, key);
    if (def == nullptr) {
      throw ConfigError(std::string(group) + "." + key +
                        ": unknown key (allowed: " + allowed_keys(defs) + ")");
    }
    if (!std::isfinite(value) || value < def->min || value > def->max) {
      std::ostringstream message;
      message << group << "." << key << ": value " << value << " outside the accepted range ["
              << def->min << ", " << def->max << "]";
      throw ConfigError(message.str());
    }
    out[key] = value;
  }
}

}  // namespace

std::span<const ParamDef> rated_param_defs(EquipmentType type) {
  switch (type) {
    case EquipmentType::kMainEngine:
      return kEngineRated;
    case EquipmentType::kGenerator:
      return kGeneratorRated;
    case EquipmentType::kCoolingSystem:
      return kCoolingRated;
    case EquipmentType::kBilgeSystem:
      return kBilgeRated;
  }
  return {};
}

std::span<const ParamDef> tuning_param_defs(EquipmentType type) {
  switch (type) {
    case EquipmentType::kMainEngine:
      return kEngineTuning;
    case EquipmentType::kGenerator:
      return kGeneratorTuning;
    case EquipmentType::kCoolingSystem:
      return kCoolingTuning;
    case EquipmentType::kBilgeSystem:
      return kBilgeTuning;
  }
  return {};
}

ParamSet::ParamSet(EquipmentType type, const ParamValues& rated, const ParamValues& parameters) {
  for (const auto defs : {rated_param_defs(type), tuning_param_defs(type)}) {
    for (const ParamDef& def : defs) values_[std::string(def.key)] = def.default_value;
  }
  overlay(rated, rated_param_defs(type), "rated", values_);
  overlay(parameters, tuning_param_defs(type), "parameters", values_);

  if (type == EquipmentType::kBilgeSystem &&
      get("pump_stop_level_cm") >= get("pump_start_level_cm")) {
    throw ConfigError("rated.pump_stop_level_cm must be below rated.pump_start_level_cm");
  }
  if (type == EquipmentType::kBilgeSystem &&
      get("degraded_level_cm") <= get("pump_start_level_cm")) {
    throw ConfigError("parameters.degraded_level_cm must be above rated.pump_start_level_cm");
  }
}

double ParamSet::get(std::string_view key) const {
  const auto it = values_.find(key);
  if (it == values_.end()) throw std::out_of_range("unknown parameter: " + std::string(key));
  return it->second;
}

}  // namespace seatrace::sim
