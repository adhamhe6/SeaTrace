#include "core/equipment_types.hpp"

#include <array>

namespace seatrace::sim {

namespace {

constexpr std::array<MeasurementTemplate, 4> kMainEngineMeasurements{{
    {"Rpm", "rpm", "rpm"},
    {"Temperature", "temperature", "°C"},
    {"Vibration", "vibration", "mm/s"},
    {"Load", "load", "%"},
}};
constexpr std::array<MeasurementTemplate, 3> kGeneratorMeasurements{{
    {"PowerOutput", "power_output", "kW"},
    {"Load", "load", "%"},
    {"Frequency", "frequency", "Hz"},
}};
constexpr std::array<MeasurementTemplate, 2> kCoolingMeasurements{{
    {"Pressure", "pressure", "bar"},
    {"Temperature", "temperature", "°C"},
}};
constexpr std::array<MeasurementTemplate, 1> kBilgeMeasurements{{
    {"WaterLevel", "water_level", "cm"},
}};

}  // namespace

std::string_view to_string(EquipmentType type) {
  switch (type) {
    case EquipmentType::kMainEngine:
      return "MainEngine";
    case EquipmentType::kGenerator:
      return "Generator";
    case EquipmentType::kCoolingSystem:
      return "CoolingSystem";
    case EquipmentType::kBilgeSystem:
      return "BilgeSystem";
  }
  return "";
}

std::string_view to_string(EquipmentState state) {
  switch (state) {
    case EquipmentState::kStopped:
      return "STOPPED";
    case EquipmentState::kStarting:
      return "STARTING";
    case EquipmentState::kRunning:
      return "RUNNING";
    case EquipmentState::kDegraded:
      return "DEGRADED";
    case EquipmentState::kTripped:
      return "TRIPPED";
    case EquipmentState::kStandby:
      return "STANDBY";
    case EquipmentState::kPumping:
      return "PUMPING";
  }
  return "";
}

std::string_view to_string(SensorHealth health) {
  switch (health) {
    case SensorHealth::kOk:
      return "OK";
    case SensorHealth::kDegraded:
      return "DEGRADED";
    case SensorHealth::kFault:
      return "FAULT";
  }
  return "";
}

std::optional<EquipmentType> parse_equipment_type(std::string_view text) {
  for (const auto type : {EquipmentType::kMainEngine, EquipmentType::kGenerator,
                          EquipmentType::kCoolingSystem, EquipmentType::kBilgeSystem}) {
    if (to_string(type) == text) return type;
  }
  return std::nullopt;
}

std::optional<EquipmentState> parse_equipment_state(std::string_view text) {
  for (const auto state :
       {EquipmentState::kStopped, EquipmentState::kStarting, EquipmentState::kRunning,
        EquipmentState::kDegraded, EquipmentState::kTripped, EquipmentState::kStandby,
        EquipmentState::kPumping}) {
    if (to_string(state) == text) return state;
  }
  return std::nullopt;
}

bool is_valid_initial_state(EquipmentType type, EquipmentState state) {
  switch (type) {
    case EquipmentType::kMainEngine:
    case EquipmentType::kGenerator:
      return state == EquipmentState::kStopped || state == EquipmentState::kStarting ||
             state == EquipmentState::kRunning;
    case EquipmentType::kCoolingSystem:
      return state == EquipmentState::kStopped || state == EquipmentState::kRunning;
    case EquipmentType::kBilgeSystem:
      return state == EquipmentState::kStandby || state == EquipmentState::kPumping;
  }
  return false;
}

std::span<const MeasurementTemplate> measurement_templates(EquipmentType type) {
  switch (type) {
    case EquipmentType::kMainEngine:
      return kMainEngineMeasurements;
    case EquipmentType::kGenerator:
      return kGeneratorMeasurements;
    case EquipmentType::kCoolingSystem:
      return kCoolingMeasurements;
    case EquipmentType::kBilgeSystem:
      return kBilgeMeasurements;
  }
  return {};
}

}  // namespace seatrace::sim
