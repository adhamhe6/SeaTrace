#pragma once

#include "core/equipment.hpp"

namespace seatrace::sim {

// Bilge well with an automatic pump.
//   level  mean-reverting seepage noise around a baseline; the bilge_flooding scenario adds an
//          ingress larger than the pump capacity (net rise of about 1 cm/s with the pump on)
//   pump   starts above pump_start_level_cm, stops below pump_stop_level_cm (hysteresis)
// States: STANDBY <-> PUMPING, and DEGRADED while the level keeps rising despite the pump.
class BilgeSystem final : public Equipment {
 public:
  BilgeSystem(const EquipmentConfig& config, std::string vessel_id, std::uint64_t seed);

  double true_value(std::string_view key) const override;
  double level_cm() const { return level_; }

 protected:
  void advance(const StepContext& context) override;

 private:
  struct Params {
    double pump_capacity;
    double pump_start_level;
    double pump_stop_level;
    double baseline_level;
    double relaxation_s;
    double inflow_sigma;
    double flood_ingress;
    double degraded_level;
    double max_level;
    static Params from(const EquipmentConfig& config);
  };

  Params p_;
  Rng process_rng_;
  double level_ = 0.0;
  double flood_level_ = 0.0;
};

}  // namespace seatrace::sim
