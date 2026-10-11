#include "core/scenario.hpp"

#include <algorithm>
#include <nlohmann/json.hpp>

namespace seatrace::sim {

namespace {

using enum ScenarioScope;

constexpr std::array<ScenarioDef, kScenarioCount> kCatalogue{{
    {ScenarioId::kEngineOverheat, "engine_overheat", kEquipment, "ME1", "", 0, 0.0,
     SensorFaultKind::kNone},
    {ScenarioId::kEngineVibration, "engine_vibration", kEquipment, "ME1", "", 0, 0.0,
     SensorFaultKind::kNone},
    {ScenarioId::kCoolingPressureLoss, "cooling_pressure_loss", kEquipment, "COOL1", "", 0, 0.0,
     SensorFaultKind::kNone},
    {ScenarioId::kBilgeFlooding, "bilge_flooding", kEquipment, "BILGE1", "", 0, 0.0,
     SensorFaultKind::kNone},
    {ScenarioId::kSensorStuck, "sensor_stuck", kSensor, "ME1", "temperature", 0, 0.0,
     SensorFaultKind::kStuck},
    {ScenarioId::kSensorOutOfRange, "sensor_out_of_range", kSensor, "COOL1", "pressure", 0, -50.0,
     SensorFaultKind::kOutOfRange},
    {ScenarioId::kSensorFailure, "sensor_failure", kSensor, "GEN1", "power_output", 0, 0.0,
     SensorFaultKind::kFailed},
    {ScenarioId::kTelemetryInterruption, "telemetry_interruption", kVessel, "", "", 60, 0.0,
     SensorFaultKind::kNone},
    {ScenarioId::kOpcuaOutage, "opcua_outage", kServer, "", "", 20, 0.0, SensorFaultKind::kNone},
}};

std::string quoted(std::string_view text) { return "'" + std::string(text) + "'"; }

}  // namespace

std::span<const ScenarioDef, kScenarioCount> scenario_catalogue() { return kCatalogue; }

const ScenarioDef& definition(ScenarioId id) { return kCatalogue[static_cast<std::size_t>(id)]; }

const ScenarioDef* find_scenario(std::string_view name) {
  const auto it = std::ranges::find(kCatalogue, name, &ScenarioDef::name);
  return it == kCatalogue.end() ? nullptr : &*it;
}

ScenarioManager::ScenarioManager(std::map<std::string, std::set<std::string>> equipment_by_vessel)
    : equipment_by_vessel_(std::move(equipment_by_vessel)) {}

std::vector<ActiveScenario>::iterator ScenarioManager::find(std::string_view vessel_id,
                                                            ScenarioId id) {
  return std::ranges::find_if(
      active_, [&](const ActiveScenario& s) { return s.id == id && s.vessel_id == vessel_id; });
}

bool ScenarioManager::is_active(std::string_view vessel_id, ScenarioId id) const {
  return std::ranges::any_of(
      active_, [&](const ActiveScenario& s) { return s.id == id && s.vessel_id == vessel_id; });
}

ScenarioResult ScenarioManager::activate(std::string_view vessel_id, std::string_view scenario_id,
                                         std::uint32_t duration_s, SimTime now) {
  const ScenarioDef* def = find_scenario(scenario_id);
  if (def == nullptr) return {false, "unknown scenario " + quoted(scenario_id)};

  // The outage is server-wide: the vessel id is ignored and stored as empty.
  const bool server_wide = def->scope == ScenarioScope::kServer;
  const std::string vessel = server_wide ? std::string() : std::string(vessel_id);
  if (!server_wide) {
    const auto vessel_it = equipment_by_vessel_.find(vessel);
    if (vessel_it == equipment_by_vessel_.end()) {
      return {false, "unknown vessel " + quoted(vessel_id)};
    }
    if (!def->target_equipment.empty() &&
        !vessel_it->second.contains(std::string(def->target_equipment))) {
      return {false, "vessel " + quoted(vessel_id) + " has no equipment " +
                         quoted(def->target_equipment) + " required by scenario " +
                         quoted(scenario_id)};
    }
  }
  if (server_wide && duration_s > kMaxOutageSeconds) {
    return {false, "durationSeconds must be between 0 and " + std::to_string(kMaxOutageSeconds) +
                       " for opcua_outage"};
  }
  if (find(vessel, def->id) != active_.end()) {
    return {false, "scenario " + quoted(scenario_id) + " is already active" +
                       (server_wide ? "" : " on vessel " + quoted(vessel_id))};
  }

  const std::uint32_t effective_s = duration_s != 0 ? duration_s : def->default_duration_s;
  ActiveScenario entry{def->id, vessel, now, std::nullopt};
  if (effective_s != 0) {
    entry.ends_at = now + std::chrono::seconds(effective_s);
    if (server_wide) *entry.ends_at += kOutageStartDelay;  // the outage lasts effective_s once down
  }
  active_.push_back(entry);

  std::string message = "scenario " + quoted(scenario_id) + " activated";
  if (!server_wide) message += " on vessel " + quoted(vessel_id);
  if (server_wide) {
    message += ": OPC UA listener stops in 1 s for " + std::to_string(effective_s) + " s";
  } else if (effective_s != 0) {
    message += " for " + std::to_string(effective_s) + " s";
  }
  return {true, message};
}

ScenarioResult ScenarioManager::clear(std::string_view vessel_id, std::string_view scenario_id) {
  if (scenario_id.empty()) {
    if (!equipment_by_vessel_.contains(std::string(vessel_id))) {
      return {false, "unknown vessel " + quoted(vessel_id)};
    }
    const auto removed =
        std::erase_if(active_, [&](const ActiveScenario& s) { return s.vessel_id == vessel_id; });
    return {true,
            "cleared " + std::to_string(removed) + " scenario(s) on vessel " + quoted(vessel_id)};
  }

  const ScenarioDef* def = find_scenario(scenario_id);
  if (def == nullptr) return {false, "unknown scenario " + quoted(scenario_id)};
  const bool server_wide = def->scope == ScenarioScope::kServer;
  if (!server_wide && !equipment_by_vessel_.contains(std::string(vessel_id))) {
    return {false, "unknown vessel " + quoted(vessel_id)};
  }
  const auto it = find(server_wide ? std::string_view() : vessel_id, def->id);
  if (it == active_.end()) {
    return {false, "scenario " + quoted(scenario_id) + " is not active" +
                       (server_wide ? "" : " on vessel " + quoted(vessel_id))};
  }
  active_.erase(it);
  return {true, "scenario " + quoted(scenario_id) + " cleared" +
                    (server_wide ? "" : " on vessel " + quoted(vessel_id))};
}

ScenarioResult ScenarioManager::reset() {
  const std::size_t count = active_.size();
  active_.clear();
  return {true, "reset: cleared " + std::to_string(count) + " scenario(s)"};
}

std::vector<ActiveScenario> ScenarioManager::expire(SimTime now) {
  std::vector<ActiveScenario> expired;
  for (const ActiveScenario& s : active_) {
    if (s.ends_at && *s.ends_at <= now) expired.push_back(s);
  }
  std::erase_if(active_, [&](const ActiveScenario& s) { return s.ends_at && *s.ends_at <= now; });
  return expired;
}

ScenarioView ScenarioManager::view_for(std::string_view vessel_id) const {
  ScenarioView view;
  for (const ActiveScenario& s : active_) {
    if (s.vessel_id == vessel_id) view.set(s.id);
  }
  return view;
}

bool ScenarioManager::listener_down(SimTime now) const {
  return std::ranges::any_of(active_, [&](const ActiveScenario& s) {
    return s.id == ScenarioId::kOpcuaOutage && now >= s.started_at + kOutageStartDelay;
  });
}

std::string ScenarioManager::active_json() const {
  nlohmann::ordered_json array = nlohmann::ordered_json::array();
  for (const ActiveScenario& s : active_) {
    nlohmann::ordered_json item;
    item["scenario_id"] = definition(s.id).name;
    item["vessel_id"] = s.vessel_id;
    item["started_at"] = format_iso8601(s.started_at);
    item["ends_at"] = s.ends_at ? nlohmann::ordered_json(format_iso8601(*s.ends_at))
                                : nlohmann::ordered_json(nullptr);
    array.push_back(std::move(item));
  }
  return array.dump();
}

}  // namespace seatrace::sim
