#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "core/config.hpp"
#include "core/scenario.hpp"
#include "core/sensor.hpp"
#include "core/sim_time.hpp"

namespace seatrace::sim {

// Everything an equipment model needs for one simulation step. The coupling fields carry the
// physical interactions between machines of the same vessel (engine <-> cooling system).
struct StepContext {
  double dt_s = 0.0;
  double elapsed_s = 0.0;  // simulated seconds since the simulation started
  SimTime now;
  ScenarioView scenarios;                      // scenarios active on this vessel
  double cooling_effectiveness = 1.0;          // 0.6 (no flow) .. 1.0 (nominal), from COOL1
  std::optional<double> engine_temperature_c;  // jacket temperature of the main engine
};

struct StateChange {
  SimTime at;
  std::string vessel_id;
  std::string equipment_code;
  EquipmentState from;
  EquipmentState to;
};

// Base class of the equipment models. A step first advances the physical process and the state
// machine (advance), then samples every sensor from the true process values.
class Equipment {
 public:
  Equipment(const EquipmentConfig& config, const std::string& vessel_id, std::uint64_t seed);
  virtual ~Equipment() = default;
  Equipment(const Equipment&) = delete;
  Equipment& operator=(const Equipment&) = delete;

  void step(const StepContext& context);

  const std::string& code() const { return config_.code; }
  const std::string& name() const { return config_.name; }
  EquipmentType type() const { return config_.type; }
  EquipmentState state() const { return state_; }
  SensorHealth sensor_health() const { return health_; }
  const std::vector<Sensor>& sensors() const { return sensors_; }
  const Sensor& sensor(std::string_view key) const;

  // The true (noise-free) process value behind a measurement key.
  virtual double true_value(std::string_view key) const = 0;

  // State changes since the last call.
  std::vector<StateChange> take_state_changes();

 protected:
  virtual void advance(const StepContext& context) = 0;

  bool scenario_active(const StepContext& context, ScenarioId id) const;
  void set_state(EquipmentState next, SimTime at);
  double state_age_s(SimTime now) const;
  const EquipmentConfig& config() const { return config_; }
  // True when a STOPPED machine has waited long enough for its configured auto-start.
  bool auto_start_due(SimTime now) const;

 private:
  SensorFault fault_for(const StepContext& context, const Sensor& sensor) const;

  EquipmentConfig config_;
  std::string vessel_id_;
  EquipmentState state_;
  std::optional<SimTime> state_since_;
  SensorHealth health_ = SensorHealth::kOk;
  std::vector<Sensor> sensors_;
  std::vector<StateChange> changes_;
};

}  // namespace seatrace::sim
