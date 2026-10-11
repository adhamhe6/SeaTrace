#pragma once

#include "core/equipment.hpp"

namespace seatrace::sim {

// Jacket cooling-water circuit of the main engine.
//   pressure     first-order lag towards the rated pressure (plus a small ripple); the
//                cooling_pressure_loss scenario drags the target down to about 0.6 bar
//   effectiveness 0.6 (no flow) .. 1.0 (rated pressure); read by the engine model
//   temperature  outlet temperature follows the heat the engine rejects:
//                sea + coupling * (engine jacket temperature - sea)
// States: STOPPED, RUNNING, DEGRADED (low pressure or high outlet temperature).
class CoolingSystem final : public Equipment {
 public:
  CoolingSystem(const EquipmentConfig& config, const std::string& vessel_id, std::uint64_t seed);

  double true_value(std::string_view key) const override;
  double effectiveness() const;
  double pressure_bar() const { return pressure_; }
  double temperature_c() const { return temperature_; }

 protected:
  void advance(const StepContext& context) override;

 private:
  struct Params {
    double rated_pressure_bar;
    double pressure_tau_s;
    double temperature_tau_s;
    double sea_temperature_c;
    double engine_coupling;
    double degraded_pressure_bar;
    double degraded_temperature_margin_c;
    double pressure_wobble_bar;
    double wobble_period_s;
    static Params from(const EquipmentConfig& config);
  };

  Params p_;
  MeasurementSpec temperature_spec_;
  double pressure_ = 0.0;
  double temperature_ = 0.0;
  double loss_level_ = 0.0;
};

}  // namespace seatrace::sim
