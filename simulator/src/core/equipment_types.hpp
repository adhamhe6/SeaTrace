#pragma once

#include <optional>
#include <span>
#include <string_view>

namespace seatrace::sim {

enum class EquipmentType { kMainEngine, kGenerator, kCoolingSystem, kBilgeSystem };

enum class EquipmentState {
  kStopped,
  kStarting,
  kRunning,
  kDegraded,
  kTripped,
  kStandby,
  kPumping
};

enum class SensorHealth { kOk, kDegraded, kFault };

std::string_view to_string(EquipmentType type);
std::string_view to_string(EquipmentState state);
std::string_view to_string(SensorHealth health);

std::optional<EquipmentType> parse_equipment_type(std::string_view text);
std::optional<EquipmentState> parse_equipment_state(std::string_view text);

// States an equipment type may be configured to start in (the others are derived at run time).
bool is_valid_initial_state(EquipmentType type, EquipmentState state);

// The measurements every equipment of a given type must provide, with the unit fixed by the
// OPC UA information model contract (docs/opc-ua-model.md).
struct MeasurementTemplate {
  std::string_view name;  // BrowseName
  std::string_view key;   // lower_snake_case
  std::string_view unit;
};

std::span<const MeasurementTemplate> measurement_templates(EquipmentType type);

}  // namespace seatrace::sim
