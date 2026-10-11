#pragma once

#include "core/equipment.hpp"

namespace seatrace::sim {

// Slow-speed two-stroke main engine.
//
// Process model (all first-order lags, see docs/opc-ua-model.md for the scenario semantics):
//   load      follows a slow sinusoidal demand profile plus an AR(1) disturbance
//   rpm       follows load (propeller-law-like linear map over the nominal bands)
//   heat      = running fraction * (0.3 + 0.7 * load)
//   T target  = ambient + gain * heat / cooling_effectiveness (+ bearing-wear heating)
//   vibration = base + rpm related term + scenario terms (scaled with the running fraction)
// The jacket temperature is therefore driven by load AND by the cooling effectiveness, which
// itself depends on the cooling pressure published by the CoolingSystem model.
//
// State machine:
//   STOPPED --(auto start)--> STARTING --(start_duration)--> RUNNING <--> DEGRADED
//   RUNNING/DEGRADED --(temperature > trip for trip_delay)--> TRIPPED
//   TRIPPED --(overheat scenario cleared, cooled below restart temperature, cooling available)-->
//   STARTING
class MainEngine final : public Equipment {
 public:
  MainEngine(const EquipmentConfig& config, const std::string& vessel_id, std::uint64_t seed);

  double true_value(std::string_view key) const override;

  // Process values and scenario levels, exposed for diagnostics and tests.
  double rpm() const { return rpm_; }
  double temperature_c() const { return temperature_; }
  double vibration() const { return vibration_; }
  double load_pct() const { return load_; }
  double overheat_level() const { return overheat_level_; }

 protected:
  void advance(const StepContext& context) override;

 private:
  struct Params {
    double trip_temperature_c;
    double trip_delay_s;
    double start_duration_s;
    double restart_temperature_c;
    double thermal_tau_s;
    double cooldown_tau_s;
    double rpm_tau_s;
    double load_tau_s;
    double ambient_c;
    double load_period_s;
    double load_phase_rad;
    double load_noise_pct;
    static Params from(const EquipmentConfig& config);
  };

  double running_fraction() const;  // 0 (stopped) .. 1 (at least 15 % of nominal rpm)
  double demand_load(const StepContext& context);
  void update_state(const StepContext& context);

  Params p_;
  // Nominal bands taken from the measurement configuration
  MeasurementSpec rpm_spec_;
  MeasurementSpec temperature_spec_;
  MeasurementSpec vibration_spec_;
  MeasurementSpec load_spec_;
  double heat_gain_ = 0.0;  // K per unit of heat at cooling effectiveness 1

  // Process state
  Rng process_rng_;
  double demand_disturbance_ = 0.0;
  double rpm_ = 0.0;
  double load_ = 0.0;
  double temperature_ = 0.0;
  double vibration_ = 0.0;
  double overheat_level_ = 0.0;
  double vibration_level_ = 0.0;
  double above_trip_s_ = 0.0;
};

}  // namespace seatrace::sim
