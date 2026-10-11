#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "core/equipment_types.hpp"
#include "core/measurement.hpp"
#include "core/params.hpp"

namespace seatrace::sim {

struct InitialScenario {
  std::string scenario_id;
  std::uint32_t duration_seconds = 0;
};

struct EquipmentConfig {
  std::string code;
  std::string name;
  EquipmentType type = EquipmentType::kMainEngine;
  EquipmentState initial_state = EquipmentState::kRunning;
  // A STOPPED machine restarts by itself after this long (never, when unset).
  std::optional<double> auto_start_after_s;
  std::vector<MeasurementSpec> measurements;  // in the order of measurement_templates(type)
  ParamValues rated;
  ParamValues parameters;

  const MeasurementSpec& measurement(std::string_view key) const;
};

struct VesselConfig {
  std::string code;
  std::string name;
  std::vector<EquipmentConfig> equipment;
  std::vector<InitialScenario> initial_scenarios;
};

struct FleetConfig {
  std::vector<VesselConfig> vessels;
};

// Parses and validates fleet.json content. Throws ConfigError with the JSON path of the problem.
FleetConfig parse_fleet_config(std::string_view json_text);
FleetConfig load_fleet_config(const std::filesystem::path& path);

}  // namespace seatrace::sim
