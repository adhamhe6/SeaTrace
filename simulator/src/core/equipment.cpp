#include "core/equipment.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace seatrace::sim {

Equipment::Equipment(const EquipmentConfig& config, const std::string& vessel_id,
                     std::uint64_t seed)
    : config_(config), vessel_id_(std::move(vessel_id)), state_(config.initial_state) {
  for (const MeasurementSpec& spec : config_.measurements) {
    const std::string label = vessel_id_ + "." + config_.code + "." + spec.name;
    sensors_.emplace_back(spec, Rng(derive_seed(seed, label)));
  }
}

const Sensor& Equipment::sensor(std::string_view key) const {
  const auto it =
      std::ranges::find_if(sensors_, [&](const Sensor& s) { return s.spec().key == key; });
  if (it == sensors_.end()) throw std::out_of_range("no sensor " + std::string(key));
  return *it;
}

void Equipment::step(const StepContext& context) {
  if (!state_since_) state_since_ = context.now;
  advance(context);

  bool any_fault = false;
  bool any_recovering = false;
  for (Sensor& sensor : sensors_) {
    sensor.sample(true_value(sensor.spec().key), fault_for(context, sensor), context.now);
    any_fault = any_fault || sensor.faulted();
    any_recovering = any_recovering || sensor.recovering(context.now);
  }
  health_ = any_fault ? SensorHealth::kFault
                      : (any_recovering ? SensorHealth::kDegraded : SensorHealth::kOk);
}

SensorFault Equipment::fault_for(const StepContext& context, const Sensor& sensor) const {
  for (const ScenarioDef& def : scenario_catalogue()) {
    if (def.scope == ScenarioScope::kSensor && def.target_equipment == config_.code &&
        def.target_measurement == sensor.spec().key && context.scenarios.active(def.id)) {
      return {def.sensor_fault, def.absurd_value};
    }
  }
  return {};
}

bool Equipment::scenario_active(const StepContext& context, ScenarioId id) const {
  return context.scenarios.active(id) && definition(id).target_equipment == config_.code;
}

void Equipment::set_state(EquipmentState next, SimTime at) {
  if (next == state_) return;
  changes_.push_back({at, vessel_id_, config_.code, state_, next});
  state_ = next;
  state_since_ = at;
}

double Equipment::state_age_s(SimTime now) const {
  return state_since_ ? std::chrono::duration<double>(now - *state_since_).count() : 0.0;
}

bool Equipment::auto_start_due(SimTime now) const {
  return config_.auto_start_after_s && state_age_s(now) >= *config_.auto_start_after_s;
}

std::vector<StateChange> Equipment::take_state_changes() { return std::exchange(changes_, {}); }

}  // namespace seatrace::sim
