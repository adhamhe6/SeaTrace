#include "core/simulation.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <utility>

namespace seatrace::sim {

namespace {

std::map<std::string, std::set<std::string>> equipment_index(const FleetConfig& config) {
  std::map<std::string, std::set<std::string>> index;
  for (const VesselConfig& vessel : config.vessels) {
    for (const EquipmentConfig& equipment : vessel.equipment) {
      index[vessel.code].insert(equipment.code);
    }
  }
  return index;
}

}  // namespace

Simulation::Simulation(const FleetConfig& config, std::uint32_t seed, SimTime start)
    : seed_(seed), now_(start), scenarios_(equipment_index(config)) {
  for (const VesselConfig& vessel : config.vessels) {
    vessels_.push_back(std::make_unique<Vessel>(vessel, seed));
  }
  for (const VesselConfig& vessel : config.vessels) {
    for (const InitialScenario& scenario : vessel.initial_scenarios) {
      const ScenarioResult result =
          scenarios_.activate(vessel.code, scenario.scenario_id, scenario.duration_seconds, now_);
      if (!result.accepted) throw ConfigError("initial scenario rejected: " + result.message);
    }
  }
  // Prime the sensors so that the very first snapshot already holds readings (zero-length step).
  advance_vessels(0.0);
}

const Vessel* Simulation::find_vessel(std::string_view code) const {
  const auto it = std::ranges::find_if(vessels_, [&](const auto& v) { return v->code() == code; });
  return it == vessels_.end() ? nullptr : it->get();
}

void Simulation::advance_vessels(double dt_s) {
  for (const auto& vessel : vessels_) {
    vessel->step(dt_s, elapsed_s_, now_, scenarios_.view_for(vessel->code()));
  }
}

void Simulation::step(std::chrono::milliseconds dt) {
  now_ += dt;
  const double dt_s = std::chrono::duration<double>(dt).count();
  elapsed_s_ += dt_s;
  auto expired = scenarios_.expire(now_);
  expired_.insert(expired_.end(), expired.begin(), expired.end());
  advance_vessels(dt_s);
  ++heartbeat_;
}

std::vector<StateChange> Simulation::take_state_changes() {
  std::vector<StateChange> all;
  for (const auto& vessel : vessels_) {
    auto changes = vessel->take_state_changes();
    all.insert(all.end(), changes.begin(), changes.end());
  }
  return all;
}

std::vector<ActiveScenario> Simulation::take_expired_scenarios() {
  return std::exchange(expired_, {});
}

}  // namespace seatrace::sim
