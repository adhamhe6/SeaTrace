#pragma once

#include <array>
#include <bitset>
#include <chrono>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "core/sim_time.hpp"

namespace seatrace::sim {

enum class ScenarioId : std::uint8_t {
  kEngineOverheat,
  kEngineVibration,
  kCoolingPressureLoss,
  kBilgeFlooding,
  kSensorStuck,
  kSensorOutOfRange,
  kSensorFailure,
  kTelemetryInterruption,
  kOpcuaOutage,
};
inline constexpr std::size_t kScenarioCount = 9;

enum class ScenarioScope { kEquipment, kSensor, kVessel, kServer };

enum class SensorFaultKind { kNone, kStuck, kOutOfRange, kFailed };

struct ScenarioDef {
  ScenarioId id;
  std::string_view name;  // scenarioId as used on the OPC UA method interface
  ScenarioScope scope;
  std::string_view target_equipment;    // equipment code, empty for vessel/server scope
  std::string_view target_measurement;  // measurement key, sensor scope only
  std::uint32_t default_duration_s;     // 0 = until cleared
  double absurd_value;                  // published by sensor_out_of_range
  SensorFaultKind sensor_fault;         // sensor scope only
};

std::span<const ScenarioDef, kScenarioCount> scenario_catalogue();
const ScenarioDef& definition(ScenarioId id);
const ScenarioDef* find_scenario(std::string_view name);

inline constexpr std::uint32_t kMaxOutageSeconds = 120;
// The OPC UA listener goes down this long after opcua_outage was accepted.
inline constexpr std::chrono::milliseconds kOutageStartDelay{1000};

// Read-only set of the scenarios active on one vessel.
class ScenarioView {
 public:
  bool active(ScenarioId id) const { return bits_.test(static_cast<std::size_t>(id)); }
  void set(ScenarioId id) { bits_.set(static_cast<std::size_t>(id)); }

 private:
  std::bitset<kScenarioCount> bits_;
};

struct ActiveScenario {
  ScenarioId id;
  std::string vessel_id;  // empty for server-wide scenarios
  SimTime started_at;
  std::optional<SimTime> ends_at;
};

struct ScenarioResult {
  bool accepted = false;
  std::string message;
};

// Owns the set of active scenarios and enforces the activation rules. All times are simulation
// times. Not thread-safe; it lives on the simulation thread like everything else.
class ScenarioManager {
 public:
  // equipment_by_vessel: vessel code -> equipment codes (used to validate scenario targets).
  explicit ScenarioManager(std::map<std::string, std::set<std::string>> equipment_by_vessel);

  ScenarioResult activate(std::string_view vessel_id, std::string_view scenario_id,
                          std::uint32_t duration_s, SimTime now);
  // Empty scenario_id clears every scenario of that vessel.
  ScenarioResult clear(std::string_view vessel_id, std::string_view scenario_id);
  ScenarioResult reset();

  // Removes scenarios whose deadline has passed and returns them.
  std::vector<ActiveScenario> expire(SimTime now);

  ScenarioView view_for(std::string_view vessel_id) const;
  const std::vector<ActiveScenario>& active() const { return active_; }
  bool is_active(std::string_view vessel_id, ScenarioId id) const;

  // True while the OPC UA listener must be down because of an opcua_outage scenario.
  bool listener_down(SimTime now) const;

  // JSON array as published in Simulator.ActiveScenarios.
  std::string active_json() const;

 private:
  std::vector<ActiveScenario>::iterator find(std::string_view vessel_id, ScenarioId id);

  std::map<std::string, std::set<std::string>> equipment_by_vessel_;
  std::vector<ActiveScenario> active_;
};

}  // namespace seatrace::sim
