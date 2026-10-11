#pragma once

#include "core/equipment.hpp"

namespace seatrace::sim {

// Auxiliary diesel generator following the electrical demand of the vessel.
//   load       demand profile (slow sinusoid + AR(1) disturbance), first-order lag
//   power      = load * rated kW
//   frequency  droops linearly with load around the rated frequency at 50 % load
// States: STOPPED -> STARTING -> RUNNING <-> DEGRADED (overload).
class Generator final : public Equipment {
 public:
  Generator(const EquipmentConfig& config, std::string vessel_id, std::uint64_t seed);

  double true_value(std::string_view key) const override;
  double load_pct() const { return load_; }

 protected:
  void advance(const StepContext& context) override;

 private:
  struct Params {
    double rated_power_kw;
    double rated_frequency_hz;
    double start_duration_s;
    double demand_period_s;
    double demand_phase_rad;
    double demand_noise_pct;
    double droop_hz;
    double load_tau_s;
    double frequency_tau_s;
    double overload_margin_pct;
    static Params from(const EquipmentConfig& config);
  };

  double demand(const StepContext& context);
  double loaded_frequency(double load_pct) const;

  Params p_;
  MeasurementSpec load_spec_;
  Rng process_rng_;
  double disturbance_ = 0.0;
  double load_ = 0.0;
  double frequency_ = 0.0;
};

}  // namespace seatrace::sim
